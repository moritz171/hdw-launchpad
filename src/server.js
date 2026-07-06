import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import multer from 'multer';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer setup für Template-Upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const templatesDir = path.join(__dirname, '..', 'templates');
    if (!fs.existsSync(templatesDir)) {
      fs.mkdirSync(templatesDir, { recursive: true });
    }
    cb(null, templatesDir);
  },
  filename: (req, file, cb) => {
    cb(null, 'master-template.html');
  }
});

const upload = multer({ storage });

// State (in production: würde in DB sein)
let currentTemplate = null;
let projectsGenerated = [];

/**
 * Utility: Generiere eindeutige Projekt-ID aus Titel
 */
function generateProjectId(title) {
  return title
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .substring(0, 30) + '-' + Date.now();
}

/**
 * Utility: Injiziere Metadaten in HTML-Template
 */
function injectMetadataIntoTemplate(template, metadata) {
  let html = template;

  // Ersetze Platzhalter
  html = html.replace(/\{\{VIDEO_TITLE\}\}/g, metadata.title || 'Untitled Project');
  html = html.replace(/\{\{VIDEO_TYPE\}\}/g, metadata.type || 'Projekt');
  html = html.replace(/\{\{PROJECT_ID\}\}/g, metadata.projectId);
  html = html.replace(/\{\{DEPLOYMENT_URL\}\}/g, metadata.deploymentUrl || '#');
  html = html.replace(/\{\{GENERATED_AT\}\}/g, new Date().toLocaleString('de-DE'));

  return html;
}

/**
 * Route: Template-Upload
 */
app.post('/api/upload-template', upload.single('template'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Keine Datei hochgeladen' });
  }

  try {
    const templatePath = path.join(__dirname, '..', 'templates', 'master-template.html');
    currentTemplate = fs.readFileSync(templatePath, 'utf-8');

    res.json({
      success: true,
      message: 'Template erfolgreich hochgeladen',
      filename: req.file.filename,
      size: req.file.size
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Route: Projekt initialisieren & starten
 */
app.post('/api/launch-project', async (req, res) => {
  const { title, type } = req.body;

  if (!title || !type) {
    return res.status(400).json({ error: 'Titel und Videotyp erforderlich' });
  }

  if (!currentTemplate) {
    return res.status(400).json({ error: 'Kein Template geladen. Bitte Template hochladen.' });
  }

  try {
    const projectId = generateProjectId(title);
    const projectDir = path.join(__dirname, '..', 'projects', projectId);

    // Erstelle Projektstruktur
    fs.mkdirSync(path.join(projectDir, 'html'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'resources'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'pdf'), { recursive: true });

    // Injiziere Metadaten in Template
    const deploymentUrl = `https://hdw-${projectId}.vercel.app`;
    const htmlContent = injectMetadataIntoTemplate(currentTemplate, {
      title,
      type,
      projectId,
      deploymentUrl
    });

    // Speichere generierte HTML
    const htmlPath = path.join(projectDir, 'html', 'index.html');
    fs.writeFileSync(htmlPath, htmlContent, 'utf-8');

    // Generiere QR-Code
    const qrPath = path.join(projectDir, 'resources', 'qr-code.png');
    await QRCode.toFile(qrPath, deploymentUrl, {
      errorCorrectionLevel: 'H',
      type: 'image/png',
      width: 300,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });

    // Erstelle vercel.json
    const vercelConfig = {
      version: 2,
      public: true,
      builds: [
        {
          src: 'html/index.html',
          use: '@vercel/static'
        }
      ],
      routes: [
        {
          src: '/(.*)',
          dest: 'html/index.html'
        }
      ]
    };
    fs.writeFileSync(
      path.join(projectDir, 'vercel.json'),
      JSON.stringify(vercelConfig, null, 2),
      'utf-8'
    );

    // Erstelle package.json für Vercel
    const packageJson = {
      name: `hdw-${projectId}`,
      version: '1.0.0',
      description: `${title} - ${type}`,
      private: true
    };
    fs.writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify(packageJson, null, 2),
      'utf-8'
    );

    projectsGenerated.push({
      projectId,
      title,
      type,
      createdAt: new Date(),
      deploymentUrl,
      localPath: projectDir
    });

    res.json({
      success: true,
      projectId,
      title,
      type,
      deploymentUrl,
      htmlPath,
      qrCodePath: qrPath,
      localPath: projectDir,
      message: 'Projekt generiert. Bereit für GitHub & Vercel-Deployment.'
    });
  } catch (error) {
    console.error('Launch Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Route: Projekt zu GitHub pushen
 */
app.post('/api/push-to-github', async (req, res) => {
  const { projectId } = req.body;

  if (!projectId) {
    return res.status(400).json({ error: 'projectId erforderlich' });
  }

  try {
    const projectDir = path.join(__dirname, '..', 'projects', projectId);

    if (!fs.existsSync(projectDir)) {
      return res.status(404).json({ error: 'Projekt nicht gefunden' });
    }

    const project = projectsGenerated.find(p => p.projectId === projectId);
    if (!project) {
      return res.status(404).json({ error: 'Projekt-Metadaten nicht gefunden' });
    }

    // Initialisiere Git-Repo im Projektverzeichnis
    execSync('git init', { cwd: projectDir, stdio: 'pipe' });
    execSync('git config user.email "moritz@heavy-media.de"', { cwd: projectDir, stdio: 'pipe' });
    execSync('git config user.name "HDW Launchpad"', { cwd: projectDir, stdio: 'pipe' });

    // Erstelle .gitignore
    fs.writeFileSync(
      path.join(projectDir, '.gitignore'),
      'node_modules/\n.env\n.vercel\n',
      'utf-8'
    );

    // Stage & commit
    execSync('git add .', { cwd: projectDir, stdio: 'pipe' });
    execSync(`git commit -m "Initial commit: ${project.title}"`, { cwd: projectDir, stdio: 'pipe' });

    // Erstelle GitHub-Repo mit gh CLI (falls Token vorhanden)
    let githubUrl = null;
    if (process.env.GITHUB_TOKEN) {
      try {
        const createRepoCmd = `gh repo create hdw-${projectId} --public --source=${projectDir} --remote=origin --push`;
        execSync(createRepoCmd, { cwd: projectDir, stdio: 'pipe' });
        githubUrl = `https://github.com/${process.env.GITHUB_OWNER}/hdw-${projectId}`;
      } catch (ghError) {
        console.warn('GitHub push failed (token might be missing):', ghError.message);
      }
    }

    project.githubUrl = githubUrl || 'GitHub-Push ausstehend (authentifizieren nötig)';

    res.json({
      success: true,
      projectId,
      message: 'Projekt zu GitHub gepusht',
      githubUrl: project.githubUrl,
      localRepo: projectDir
    });
  } catch (error) {
    console.error('GitHub Push Error:', error);
    res.status(500).json({
      error: error.message,
      hint: 'Stelle sicher, dass du `gh auth login` ausgeführt hast'
    });
  }
});

/**
 * Route: QR-Code herunterladen
 */
app.get('/api/download-qr/:projectId', (req, res) => {
  const { projectId } = req.params;
  const qrPath = path.join(__dirname, '..', 'projects', projectId, 'resources', 'qr-code.png');

  if (!fs.existsSync(qrPath)) {
    return res.status(404).json({ error: 'QR-Code nicht gefunden' });
  }

  res.download(qrPath, `qr-${projectId}.png`);
});

/**
 * Route: Projekt-Status
 */
app.get('/api/projects', (req, res) => {
  res.json({
    totalProjects: projectsGenerated.length,
    projects: projectsGenerated.map(p => ({
      projectId: p.projectId,
      title: p.title,
      type: p.type,
      deploymentUrl: p.deploymentUrl,
      githubUrl: p.githubUrl,
      createdAt: p.createdAt
    }))
  });
});

/**
 * Route: Template-Status
 */
app.get('/api/template-status', (req, res) => {
  res.json({
    hasTemplate: !!currentTemplate,
    templateSize: currentTemplate ? currentTemplate.length : 0
  });
});

/**
 * Serve das Frontend
 */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * Start Server
 */
app.listen(PORT, () => {
  console.log(`\n✨ HDW Launchpad läuft auf http://localhost:${PORT}\n`);
});

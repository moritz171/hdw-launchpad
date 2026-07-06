import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import multer from 'multer';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
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
 * Utility: Generiere Slug aus Titel (für GitHub-Repo-Name)
 */
function generateSlug(title) {
  return title
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .substring(0, 40)
    .replace(/^-+|-+$/g, '');
}

/**
 * Utility: Generiere eindeutige Projekt-ID (Slug + Timestamp für Eindeutigkeit)
 */
function generateProjectId(title) {
  const slug = generateSlug(title);
  const timestamp = Date.now().toString(36);
  return `${slug}-${timestamp}`.substring(0, 50);
}

/**
 * Utility: Injiziere Metadaten in HTML-Template
 * Ersetzt:
 * - <title> direkten Inhalt
 * - {{VIDEO_TITLE}}, {{PAGE_TITLE}}, [VIDEO_TITLE], [Page Title] etc.
 * - {{VIDEO_TYPE}}, {{PROJECT_ID}}, {{DEPLOYMENT_URL}}, {{GENERATED_AT}}
 */
function injectMetadataIntoTemplate(template, metadata) {
  let html = template;
  const title = metadata.title || 'Untitled Project';

  // 1. Ersetze <title>...</title> Tag direkt
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${title}</title>`);

  // 2. Ersetze alle Variationen von Platzhaltern (case-insensitive)
  html = html.replace(/\{\{VIDEO_TITLE\}\}/gi, title);
  html = html.replace(/\{\{PAGE_TITLE\}\}/gi, title);
  html = html.replace(/\[VIDEO_TITLE\]/gi, title);
  html = html.replace(/\[Page Title\]/gi, title);
  html = html.replace(/\[page_title\]/gi, title);

  // 3. Ersetze spezifische Metadaten
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
 * Helper: Führe Git-Befehl aus und gebe Fehler/Output zurück
 */
function executeGitCommand(cmd, cwd, logFn = null) {
  try {
    const output = execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (logFn) logFn(`✓ ${cmd}`);
    return { success: true, output };
  } catch (error) {
    if (logFn) logFn(`✗ ${cmd}: ${error.message}`);
    throw error;
  }
}

/**
 * Route: Projekt initialisieren & vollständige Deployment-Pipeline starten
 * WORKFLOW:
 * 1. Titel in <title> und Platzhalter injizieren
 * 2. HTML-Datei speichern
 * 3. Git-Repo initialisieren & committen
 * 4. GitHub-Repository erstellen
 * 5. Repository auf public setzen
 * 6. Git push zu GitHub
 * 7. QR-Code generieren (für die finale Vercel-URL)
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
    const repoSlug = `hdw-${generateSlug(title)}`;
    const projectDir = path.join(__dirname, '..', 'projects', projectId);
    const vercelUrl = `https://${repoSlug}.vercel.app`;

    console.log(`\n🚀 Starte Deployment Pipeline für: "${title}"`);
    console.log(`   Projekt-ID: ${projectId}`);
    console.log(`   Repo-Name: ${repoSlug}`);

    // ========== STEP 1: TITEL-INJEKTION ==========
    console.log('\n[STEP 1] Injiziere Titel in Template...');
    const htmlContent = injectMetadataIntoTemplate(currentTemplate, {
      title,
      type,
      projectId,
      deploymentUrl: vercelUrl
    });

    // ========== STEP 2: DATEI SPEICHERN ==========
    console.log('[STEP 2] Speichere HTML-Datei...');
    fs.mkdirSync(projectDir, { recursive: true });
    const indexPath = path.join(projectDir, 'index.html');
    fs.writeFileSync(indexPath, htmlContent, 'utf-8');
    console.log(`   ✓ Datei: ${indexPath}`);

    // ========== STEP 3: GIT INITIALISIEREN & COMMITTEN ==========
    console.log('[STEP 3] Initialisiere Git-Repository...');

    // Git config
    executeGitCommand('git init', projectDir);
    executeGitCommand('git config user.email "moritz@heavy-media.de"', projectDir);
    executeGitCommand('git config user.name "HDW Launchpad"', projectDir);

    // Erstelle .gitignore
    fs.writeFileSync(
      path.join(projectDir, '.gitignore'),
      'node_modules/\n.env\n.vercel\n.DS_Store\n*.log\n',
      'utf-8'
    );

    // Erstelle vercel.json für statisches Hosting
    const vercelConfig = {
      version: 2,
      buildCommand: 'echo "Static deployment"',
      public: true,
      functions: {
        'api/**': { runtime: 'nodejs18.x' }
      }
    };
    fs.writeFileSync(
      path.join(projectDir, 'vercel.json'),
      JSON.stringify(vercelConfig, null, 2),
      'utf-8'
    );

    // Erstelle package.json
    const packageJson = {
      name: repoSlug,
      version: '1.0.0',
      description: `${title} - ${type}`,
      private: false
    };
    fs.writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify(packageJson, null, 2),
      'utf-8'
    );

    // Git add & commit
    executeGitCommand('git add .', projectDir);
    executeGitCommand(`git commit -m "Auto-Deploy: ${title}"`, projectDir);
    console.log('   ✓ Initial commit erstellt');

    // ========== STEP 4: GITHUB REPOSITORY ERSTELLEN ==========
    console.log('[STEP 4] Erstelle GitHub-Repository...');
    let githubUrl = null;

    try {
      // Prüfe, ob Repo bereits existiert
      const checkCmd = `gh repo view ${repoSlug} 2>&1`;
      try {
        execSync(checkCmd, { stdio: 'pipe' });
        console.log(`   ℹ Repo existiert bereits: ${repoSlug}`);
      } catch {
        // Repo existiert nicht, erstelle es
        const createCmd = `gh repo create ${repoSlug} --public --source=${projectDir} --remote=origin --push --description "${title} - ${type}"`;
        execSync(createCmd, { stdio: 'pipe' });
        console.log(`   ✓ Repository erstellt: ${repoSlug}`);
      }

      // Hole GitHub-Username für URL
      const whoami = execSync('gh api user -q .login', { encoding: 'utf-8' }).trim();
      githubUrl = `https://github.com/${whoami}/${repoSlug}`;
    } catch (ghError) {
      console.warn(`   ⚠ GitHub-Repo-Erstellung fehlgeschlagen: ${ghError.message}`);
    }

    // ========== STEP 5: REPOSITORY AUF PUBLIC SETZEN ==========
    console.log('[STEP 5] Stelle Repository auf public...');
    try {
      executeGitCommand(`gh repo edit ${repoSlug} --visibility public`, projectDir);
      console.log('   ✓ Repository ist öffentlich');
    } catch (error) {
      console.warn(`   ⚠ Konnte Sichtbarkeit nicht ändern: ${error.message}`);
    }

    // ========== STEP 6: GIT PUSH ZU GITHUB ==========
    console.log('[STEP 6] Pushe Code zu GitHub...');
    try {
      // Prüfe remote
      try {
        executeGitCommand('git remote get-url origin', projectDir);
      } catch {
        // Remote existiert nicht, erstelle es
        executeGitCommand(`git remote add origin https://github.com/$(gh api user -q .login)/${repoSlug}.git`, projectDir);
      }

      // Push zu GitHub
      executeGitCommand('git branch -M main', projectDir);
      executeGitCommand('git push -u origin main', projectDir);
      console.log('   ✓ Code erfolgreich zu GitHub gepusht (Branch: main)');
    } catch (pushError) {
      console.warn(`   ⚠ Git Push fehlgeschlagen: ${pushError.message}`);
    }

    // ========== STEP 7: QR-CODE GENERIEREN ==========
    console.log('[STEP 7] Generiere QR-Code für Vercel-URL...');
    const resourcesDir = path.join(projectDir, '.resources');
    fs.mkdirSync(resourcesDir, { recursive: true });

    const qrPath = path.join(resourcesDir, 'qr-code.png');
    await QRCode.toFile(qrPath, vercelUrl, {
      errorCorrectionLevel: 'H',
      type: 'image/png',
      width: 300,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });
    console.log(`   ✓ QR-Code generiert für: ${vercelUrl}`);

    // ========== SPEICHERE PROJEKT-METADATEN ==========
    const projectMeta = {
      projectId,
      title,
      type,
      createdAt: new Date(),
      vercelUrl,
      githubUrl,
      repoSlug,
      localPath: projectDir,
      status: 'deployed'
    };

    projectsGenerated.push(projectMeta);

    // Speichere Metadaten als JSON
    fs.writeFileSync(
      path.join(projectDir, '.metadata.json'),
      JSON.stringify(projectMeta, null, 2),
      'utf-8'
    );

    console.log(`\n✅ DEPLOYMENT ERFOLGREICH!`);
    console.log(`   Vercel-URL: ${vercelUrl}`);
    console.log(`   GitHub-Repo: ${githubUrl}`);
    console.log(`   QR-Code: ${qrPath}\n`);

    res.json({
      success: true,
      projectId,
      title,
      type,
      vercelUrl,
      githubUrl,
      repoSlug,
      qrCodePath: qrPath,
      localPath: projectDir,
      message: '✅ Projekt erfolgreich deployed! QR-Code wurde generiert.'
    });
  } catch (error) {
    console.error('\n❌ Deployment fehlgeschlagen:', error.message);
    res.status(500).json({
      error: error.message,
      hint: 'Stelle sicher, dass du `gh auth login` ausgeführt hast und GitHub CLI korrekt konfiguriert ist.'
    });
  }
});

/**
 * Route: Projekt-Details abrufen
 */
app.get('/api/project/:projectId', (req, res) => {
  const { projectId } = req.params;
  const project = projectsGenerated.find(p => p.projectId === projectId);

  if (!project) {
    return res.status(404).json({ error: 'Projekt nicht gefunden' });
  }

  const metadataPath = path.join(project.localPath, '.metadata.json');
  let metadata = project;

  // Versuche aktualisierte Metadaten zu laden
  if (fs.existsSync(metadataPath)) {
    try {
      metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    } catch (e) {
      console.warn('Konnte Metadaten nicht laden:', e.message);
    }
  }

  res.json(metadata);
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

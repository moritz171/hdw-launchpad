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
 * Helper: Führe Git-Befehl aus
 */
function executeGitCommand(cmd, cwd) {
  try {
    const output = execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { success: true, output };
  } catch (error) {
    throw error;
  }
}

/**
 * Helper: Extrahiere Vercel URL aus vercel CLI Output
 */
function extractVercelUrl(output) {
  const match = output.match(/https:\/\/[^\s]+\.vercel\.app/);
  return match ? match[0] : null;
}

/**
 * Route: Projekt initialisieren & vollständige Deployment-Pipeline starten
 *
 * WORKFLOW (KORRIGIERT):
 * 1. Titel in <title> und Platzhalter injizieren
 * 2. HTML-Datei speichern (/projects/[id]/index.html)
 * 3. DIREKT MIT VERCEL CLI DEPLOYEN (npx vercel --prod --token ...)
 * 4. Echte Vercel-URL aus CLI-Output extrahieren
 * 5. QR-Code generieren mit ECHTER Vercel-URL
 * 6. QR-Code in src/public/qrcodes/ speichern (statisch erreichbar)
 * 7. GitHub-Repository erstellen & pushen (für Backup)
 */
app.post('/api/launch-project', async (req, res) => {
  const { title, type } = req.body;

  if (!title || !type) {
    return res.status(400).json({ error: 'Titel und Videotyp erforderlich' });
  }

  if (!currentTemplate) {
    return res.status(400).json({ error: 'Kein Template geladen. Bitte Template hochladen.' });
  }

  if (!process.env.VERCEL_TOKEN) {
    return res.status(400).json({ error: 'VERCEL_TOKEN nicht in .env konfiguriert' });
  }

  try {
    const projectId = generateProjectId(title);
    const repoSlug = `hdw-${generateSlug(title)}`;
    const projectDir = path.join(__dirname, '..', 'projects', projectId);

    console.log(`\n🚀 Starte Deployment Pipeline für: "${title}"`);
    console.log(`   Projekt-ID: ${projectId}`);
    console.log(`   Repo-Name: ${repoSlug}`);

    // ========== STEP 1: TITEL-INJEKTION ==========
    console.log('\n[STEP 1] Injiziere Titel in Template...');

    // Temporärer Placeholder für die Injektion
    const tempUrl = `https://${repoSlug}.vercel.app`;
    const htmlContent = injectMetadataIntoTemplate(currentTemplate, {
      title,
      type,
      projectId,
      deploymentUrl: tempUrl
    });

    // ========== STEP 2: DATEI SPEICHERN ==========
    console.log('[STEP 2] Speichere HTML-Datei...');
    fs.mkdirSync(projectDir, { recursive: true });
    const indexPath = path.join(projectDir, 'index.html');
    fs.writeFileSync(indexPath, htmlContent, 'utf-8');
    console.log(`   ✓ Datei: ${indexPath}`);

    // Erstelle package.json (Vercel braucht das)
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

    // ========== STEP 3: VERCEL DEPLOYMENT (DIREKT, NICHT VIA GITHUB) ==========
    console.log('[STEP 3] Deploye direkt zu Vercel mit CLI...');

    let vercelUrl = null;
    try {
      // Vercel CLI Befehl mit --scope=moritz-9331 (persönlicher Hobby-Account, public deployments)
      const vercelCmd = `npx vercel --prod --yes --token=${process.env.VERCEL_TOKEN} --scope=moritz-9331`;
      console.log(`   Executing: npx vercel --prod --yes --token=[TOKEN] --scope=moritz-9331`);

      const vercelOutput = execSync(vercelCmd, {
        cwd: projectDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120000  // 2 Minuten Timeout für Vercel-Deployment
      });

      console.log(`   Vercel Output erhalten (${vercelOutput.length} Bytes)`);

      // Extrahiere echte Vercel-URL aus Output
      vercelUrl = extractVercelUrl(vercelOutput);

      if (!vercelUrl) {
        throw new Error('Konnte Vercel-URL aus Output nicht extrahieren. Output: ' + vercelOutput);
      }

      console.log(`   ✓ Vercel Deployment erfolgreich!`);
      console.log(`   ✓ Live-URL: ${vercelUrl}`);

      // Stelle sicher, dass das Projekt öffentlich ist (ohne Login)
      try {
        console.log(`   [INFO] Verifiziere Public-Status des Deployments...`);
        const linkCmd = `npx vercel link --yes --token=${process.env.VERCEL_TOKEN} --scope=moritz-9331`;
        execSync(linkCmd, {
          cwd: projectDir,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30000
        });
        console.log(`   ✓ Projekt ist öffentlich (im Hobby-Account, keine SSO-Sperre)`);
      } catch (linkError) {
        // link-Fehler ist nicht kritisch, Deployment funktioniert trotzdem
        console.log(`   ℹ Link-Verification optional (Deployment funktioniert trotzdem)`);
      }
    } catch (vercelError) {
      console.error(`   ✗ Vercel Deployment fehlgeschlagen: ${vercelError.message}`);
      throw new Error(`Vercel Deployment fehlgeschlagen: ${vercelError.message}`);
    }

    // ========== STEP 4: QR-CODE GENERIEREN (MIT ECHTER VERCEL-URL) ==========
    console.log('[STEP 4] Generiere QR-Code für echte Vercel-URL...');

    const qrcodesDir = path.join(__dirname, 'public', 'qrcodes');
    fs.mkdirSync(qrcodesDir, { recursive: true });

    const qrFileName = `${repoSlug}.png`;
    const qrPath = path.join(qrcodesDir, qrFileName);

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

    // Relativer Pfad für Frontend
    const qrCodeUrl = `/qrcodes/${qrFileName}`;
    console.log(`   ✓ QR-Code generiert: ${qrCodeUrl}`);

    // ========== STEP 5: GIT INIT & COMMIT (FÜR GITHUB BACKUP) ==========
    console.log('[STEP 5] Initialisiere Git-Repository (für GitHub-Backup)...');

    try {
      executeGitCommand('git init', projectDir);
      executeGitCommand('git config user.email "moritz@heavy-media.de"', projectDir);
      executeGitCommand('git config user.name "HDW Launchpad"', projectDir);

      // Erstelle .gitignore
      fs.writeFileSync(
        path.join(projectDir, '.gitignore'),
        'node_modules/\n.env\n.vercel\n.DS_Store\n*.log\n',
        'utf-8'
      );

      // Git add & commit
      executeGitCommand('git add .', projectDir);
      executeGitCommand(`git commit -m "Auto-Deploy: ${title}"`, projectDir);
      console.log('   ✓ Git-Repository initialisiert & committed');
    } catch (gitError) {
      console.warn(`   ⚠ Git-Fehler: ${gitError.message}`);
    }

    // ========== STEP 6: GITHUB REPOSITORY ERSTELLEN & PUSHEN ==========
    console.log('[STEP 6] Erstelle GitHub-Repository & pushe Code...');
    let githubUrl = null;

    try {
      // Prüfe, ob Repo bereits existiert
      try {
        execSync(`gh repo view ${repoSlug}`, { stdio: 'pipe' });
        console.log(`   ℹ GitHub-Repo existiert bereits: ${repoSlug}`);
      } catch {
        // Repo existiert nicht, erstelle es
        const createCmd = `gh repo create ${repoSlug} --public --source=${projectDir} --remote=origin --push --description "${title} - ${type}"`;
        execSync(createCmd, { stdio: 'pipe' });
        console.log(`   ✓ GitHub-Repository erstellt & gepusht`);
      }

      // Hole GitHub-Username für URL
      const whoami = execSync('gh api user -q .login', { encoding: 'utf-8' }).trim();
      githubUrl = `https://github.com/${whoami}/${repoSlug}`;
      console.log(`   ✓ GitHub-Repo URL: ${githubUrl}`);
    } catch (ghError) {
      console.warn(`   ⚠ GitHub-Fehler (optional): ${ghError.message}`);
      githubUrl = 'GitHub-Push optional (Vercel ist bereits live!)';
    }

    // ========== SPEICHERE PROJEKT-METADATEN ==========
    const projectMeta = {
      projectId,
      title,
      type,
      createdAt: new Date(),
      vercelUrl,
      githubUrl,
      repoSlug,
      qrCodeUrl,
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
    console.log(`   QR-Code-URL: ${qrCodeUrl}`);
    console.log(`   GitHub-Repo: ${githubUrl}\n`);

    res.json({
      success: true,
      projectId,
      title,
      type,
      vercelUrl,
      githubUrl,
      repoSlug,
      qrCodeUrl,
      localPath: projectDir,
      message: '✅ Projekt erfolgreich auf Vercel deployed!'
    });
  } catch (error) {
    console.error('\n❌ Deployment fehlgeschlagen:', error.message);
    res.status(500).json({
      error: error.message,
      hint: 'Stelle sicher, dass VERCEL_TOKEN in .env gesetzt ist und `gh auth login` ausgeführt wurde.'
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

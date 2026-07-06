# 🚀 HDW Launchpad

Ein professionelles Dashboard zum Generieren, Deployen und Verwalten von Video-Projekten mit automatischer GitHub- und Vercel-Integration.

## 🎯 Features

- **Master-Template Upload**: Lade dein HTML-Template hoch und nutze es als Basis für alle Projekte
- **Projekt-Metadaten**: Gib Videotitel, Typ und weitere Informationen ein
- **Automatische Generierung**: Injiziere Metadaten in dein Template
- **QR-Code Terminal**: Generiere QR-Codes für jeden Deployment-Link automatisch
- **GitHub Integration**: Pushe Projekte automatisch zu GitHub (mit gh CLI)
- **Vercel Deployment**: Deploye Projekte mit einem Klick auf Vercel
- **Live-Status Logs**: Terminal-ähnliche Logs für Echtzeit-Deployment-Status
- **Skalierbare Struktur**: Verwalte 500+ Projekte ohne Performance-Probleme

## 📁 Projektstruktur

```
hdw-launchpad/
├── src/
│   ├── server.js          # Express Backend mit API
│   └── public/
│       └── index.html     # Tailwind CSS Frontend
├── templates/
│   └── master-template.html  # Master-Template (von Benutzer hochgeladen)
├── projects/
│   └── [project-id]/
│       ├── html/          # Fertige injizierte HTML
│       ├── resources/     # QR-Code, Bilder, etc.
│       └── pdf/           # Zukünftige PDF-Anleitungen
├── .env                   # API-Keys & Konfiguration
└── vercel.json           # Vercel-Konfiguration
```

## 🚀 Schnellstart

### Installation
```bash
npm install
```

### Entwicklung
```bash
npm run dev
# Öffne http://localhost:3000
```

### Production
```bash
vercel --prod
```

## 🔐 Authentifizierung

### GitHub
```bash
gh auth login
# Wähle "HTTPS" und "Y" für Token
```

### Vercel
```bash
vercel login
```

## 📡 API Endpoints

| Method | Endpoint | Beschreibung |
|--------|----------|-------------|
| POST | `/api/upload-template` | Master-Template hochladen |
| POST | `/api/launch-project` | Projekt initialisieren & generieren |
| POST | `/api/push-to-github` | Zu GitHub pushen |
| GET | `/api/download-qr/:projectId` | QR-Code herunterladen |
| GET | `/api/projects` | Alle Projekte auflisten |
| GET | `/api/template-status` | Template-Status prüfen |

## 🛠️ Environment-Variablen

```env
PORT=3000
NODE_ENV=development
GITHUB_TOKEN=ghp_xxxxx
VERCEL_TOKEN=vercel_xxxxx
GITHUB_USER=moritz171
GITHUB_OWNER=moritz171
USER_EMAIL=moritz@heavy-media.de
```

## 📦 Dependencies

- **Express**: Web-Framework
- **Multer**: Datei-Upload
- **QRCode**: QR-Code-Generierung
- **Tailwind CSS**: Styling
- **GitHub CLI**: Repository-Verwaltung
- **Vercel CLI**: Deployment

## 🎨 Design-System

- **Farbe**: Dark Mode mit orange Akzenten (#ff6600)
- **Fonts**: Montserrat, JetBrains Mono, Hanken Grotesk
- **Theme**: Industrial/Werkstatt-Ästhetik für "Helden der Werkstatt"

## 🔗 Links

- GitHub: https://github.com/moritz171/hdw-launchpad
- Repository: moritz171/hdw-launchpad
- Vercel Account: moritz-9331

---

**© 2026 Helden der Werkstatt - All Rights Reserved**

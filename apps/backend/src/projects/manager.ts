import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { reconnectDb } from '../db.js';

// @ts-ignore — import.meta.url works at runtime via tsx/ESM; electron tsc compile doesn't execute this
const __dirname_esm = path.dirname(fileURLToPath(import.meta.url));

const PROJECTS_DIR = path.join(os.homedir(), '.sniff', 'projects');
const META_FILE = path.join(os.homedir(), '.sniff', 'projects.json');

// Default DB path (the "unsaved" working DB)
const DEFAULT_DB = path.resolve(__dirname_esm, '../../prisma/sniff.db');

interface ProjectMeta {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  dbFile: string; // filename within PROJECTS_DIR
}

interface ProjectsIndex {
  activeProjectId: string | null;
  projects: ProjectMeta[];
}

function ensureDirs() {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}

function readIndex(): ProjectsIndex {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
  } catch {
    return { activeProjectId: null, projects: [] };
  }
}

function writeIndex(index: ProjectsIndex) {
  ensureDirs();
  fs.writeFileSync(META_FILE, JSON.stringify(index, null, 2));
}

function generateId(): string {
  return `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export const projectManager = {
  list(): ProjectMeta[] {
    return readIndex().projects;
  },

  getActive(): { id: string | null; name: string | null } {
    const index = readIndex();
    if (!index.activeProjectId) return { id: null, name: null };
    const proj = index.projects.find((p) => p.id === index.activeProjectId);
    return { id: index.activeProjectId, name: proj?.name ?? null };
  },

  async create(name: string, description: string = ''): Promise<ProjectMeta> {
    ensureDirs();
    const id = generateId();
    const dbFile = `${id}.db`;
    const dbPath = path.join(PROJECTS_DIR, dbFile);

    // Copy current DB as the new project's starting point
    fs.copyFileSync(DEFAULT_DB, dbPath);

    const meta: ProjectMeta = {
      id,
      name,
      description,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      dbFile,
    };

    const index = readIndex();
    index.projects.push(meta);
    writeIndex(index);

    return meta;
  },

  async saveAs(name: string, description: string = ''): Promise<ProjectMeta> {
    ensureDirs();
    const index = readIndex();

    // If there's an active project, save the current DB to it first
    if (index.activeProjectId) {
      const active = index.projects.find((p) => p.id === index.activeProjectId);
      if (active) {
        const activePath = path.join(PROJECTS_DIR, active.dbFile);
        fs.copyFileSync(DEFAULT_DB, activePath);
        active.updatedAt = new Date().toISOString();
      }
    }

    // Create new project from current state
    const id = generateId();
    const dbFile = `${id}.db`;
    const dbPath = path.join(PROJECTS_DIR, dbFile);
    fs.copyFileSync(DEFAULT_DB, dbPath);

    const meta: ProjectMeta = {
      id,
      name,
      description,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      dbFile,
    };

    index.projects.push(meta);
    index.activeProjectId = id;
    writeIndex(index);

    return meta;
  },

  async save(): Promise<boolean> {
    const index = readIndex();
    if (!index.activeProjectId) return false;

    const proj = index.projects.find((p) => p.id === index.activeProjectId);
    if (!proj) return false;

    const dbPath = path.join(PROJECTS_DIR, proj.dbFile);
    fs.copyFileSync(DEFAULT_DB, dbPath);
    proj.updatedAt = new Date().toISOString();
    writeIndex(index);
    return true;
  },

  async open(projectId: string): Promise<ProjectMeta | null> {
    const index = readIndex();
    const proj = index.projects.find((p) => p.id === projectId);
    if (!proj) return null;

    const dbPath = path.join(PROJECTS_DIR, proj.dbFile);
    if (!fs.existsSync(dbPath)) return null;

    // Save current project first if one is active
    if (index.activeProjectId) {
      const current = index.projects.find((p) => p.id === index.activeProjectId);
      if (current) {
        const currentPath = path.join(PROJECTS_DIR, current.dbFile);
        fs.copyFileSync(DEFAULT_DB, currentPath);
        current.updatedAt = new Date().toISOString();
      }
    }

    // Copy project DB to working location and reconnect
    fs.copyFileSync(dbPath, DEFAULT_DB);
    await reconnectDb(`file:${DEFAULT_DB}`);

    index.activeProjectId = projectId;
    writeIndex(index);
    return proj;
  },

  async newProject(): Promise<void> {
    const index = readIndex();

    // Save current project if active
    if (index.activeProjectId) {
      const current = index.projects.find((p) => p.id === index.activeProjectId);
      if (current) {
        const currentPath = path.join(PROJECTS_DIR, current.dbFile);
        fs.copyFileSync(DEFAULT_DB, currentPath);
        current.updatedAt = new Date().toISOString();
      }
    }

    // Delete working DB and reconnect (Prisma will recreate empty tables)
    if (fs.existsSync(DEFAULT_DB)) {
      fs.unlinkSync(DEFAULT_DB);
    }

    // Run prisma migrate to recreate schema
    const { execSync } = await import('child_process');
    const backendDir = path.resolve(__dirname_esm, '../..');
    execSync('npx prisma db push --skip-generate', {
      cwd: backendDir,
      env: { ...process.env, DATABASE_URL: `file:${DEFAULT_DB}` },
      stdio: 'pipe',
    });

    await reconnectDb(`file:${DEFAULT_DB}`);

    index.activeProjectId = null;
    writeIndex(index);
  },

  async deleteProject(projectId: string): Promise<boolean> {
    const index = readIndex();
    const projIdx = index.projects.findIndex((p) => p.id === projectId);
    if (projIdx === -1) return false;

    const proj = index.projects[projIdx];
    const dbPath = path.join(PROJECTS_DIR, proj.dbFile);

    // Remove DB file
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }

    // Remove from index
    index.projects.splice(projIdx, 1);
    if (index.activeProjectId === projectId) {
      index.activeProjectId = null;
    }
    writeIndex(index);
    return true;
  },

  async rename(projectId: string, name: string, description?: string): Promise<ProjectMeta | null> {
    const index = readIndex();
    const proj = index.projects.find((p) => p.id === projectId);
    if (!proj) return null;

    proj.name = name;
    if (description !== undefined) proj.description = description;
    proj.updatedAt = new Date().toISOString();
    writeIndex(index);
    return proj;
  },
};

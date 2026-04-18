import { pipeline, type FeatureExtractionPipeline } from '@xenova/transformers';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'; // 384-dim, ~23MB, runs locally
const PERSIST_DIR = join(process.cwd(), '.sniff-data');
const INDEX_FILE = join(PERSIST_DIR, 'vector-index.json');

// Batch config
const MAX_DOCS = 5000; // cap stored documents
const SAVE_INTERVAL = 30_000; // persist every 30s if dirty

interface StoredDocument {
  id: string;
  text: string;
  embedding: number[];
  metadata: Record<string, string | number | boolean | null>;
  timestamp: number;
}

interface PersistedIndex {
  version: 1;
  documents: StoredDocument[];
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

class VectorStore {
  private documents: StoredDocument[] = [];
  private embedder: FeatureExtractionPipeline | null = null;
  private loading: Promise<FeatureExtractionPipeline> | null = null;
  private dirty = false;
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  private _ready = false;

  async init() {
    // Load persisted index
    await this.loadFromDisk();

    // Start loading model in background (don't block startup)
    this.loading = this.loadModel();
    this.loading.then(() => {
      this._ready = true;
      console.log(`[vector-store] ready — ${this.documents.length} documents indexed`);
    }).catch((err) => {
      console.error('[vector-store] failed to load embedding model:', err.message);
    });

    // Periodic persist
    this.saveTimer = setInterval(() => {
      if (this.dirty) this.saveToDisk().catch(() => {});
    }, SAVE_INTERVAL);
  }

  private async loadModel(): Promise<FeatureExtractionPipeline> {
    console.log('[vector-store] loading embedding model...');
    const extractor = await pipeline('feature-extraction', MODEL_ID, {
      // @ts-ignore - quantized option
      quantized: true,
    });
    this.embedder = extractor;
    return extractor;
  }

  private async getEmbedder(): Promise<FeatureExtractionPipeline> {
    if (this.embedder) return this.embedder;
    if (this.loading) return this.loading;
    this.loading = this.loadModel();
    return this.loading;
  }

  async embed(text: string): Promise<number[]> {
    const embedder = await this.getEmbedder();
    const output = await embedder(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data as Float32Array);
  }

  async add(id: string, text: string, metadata: Record<string, string | number | boolean | null> = {}) {
    // Skip if already indexed
    if (this.documents.some((d) => d.id === id)) return;

    const embedding = await this.embed(text);
    this.documents.push({ id, text, embedding, metadata, timestamp: Date.now() });
    this.dirty = true;

    // Evict oldest if over cap
    if (this.documents.length > MAX_DOCS) {
      this.documents.sort((a, b) => b.timestamp - a.timestamp);
      this.documents = this.documents.slice(0, MAX_DOCS);
    }
  }

  async query(
    queryText: string,
    topK = 10,
    filter?: Record<string, string | number | boolean | null>,
  ): Promise<Array<{ id: string; text: string; score: number; metadata: Record<string, string | number | boolean | null> }>> {
    if (this.documents.length === 0) return [];

    const queryEmb = await this.embed(queryText);

    let candidates = this.documents;
    if (filter) {
      candidates = candidates.filter((doc) => {
        for (const [k, v] of Object.entries(filter)) {
          if (doc.metadata[k] !== v) return false;
        }
        return true;
      });
    }

    const scored = candidates.map((doc) => ({
      id: doc.id,
      text: doc.text,
      score: cosineSimilarity(queryEmb, doc.embedding),
      metadata: doc.metadata,
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  getDocumentCount(): number {
    return this.documents.length;
  }

  isReady(): boolean {
    return this._ready;
  }

  hasDocument(id: string): boolean {
    return this.documents.some((d) => d.id === id);
  }

  async clear() {
    this.documents = [];
    this.dirty = true;
    await this.saveToDisk();
    console.log('[vector-store] cleared all documents');
  }

  private async loadFromDisk() {
    try {
      if (!existsSync(INDEX_FILE)) return;
      const raw = await readFile(INDEX_FILE, 'utf-8');
      const data: PersistedIndex = JSON.parse(raw);
      if (data.version === 1 && Array.isArray(data.documents)) {
        this.documents = data.documents;
      }
    } catch {
      // Fresh start if corrupt
      this.documents = [];
    }
  }

  async saveToDisk() {
    try {
      if (!existsSync(PERSIST_DIR)) {
        await mkdir(PERSIST_DIR, { recursive: true });
      }
      const data: PersistedIndex = { version: 1, documents: this.documents };
      await writeFile(INDEX_FILE, JSON.stringify(data));
      this.dirty = false;
    } catch (err) {
      console.error('[vector-store] failed to persist:', (err as Error).message);
    }
  }

  async shutdown() {
    if (this.saveTimer) clearInterval(this.saveTimer);
    if (this.dirty) await this.saveToDisk();
  }
}

export const vectorStore = new VectorStore();

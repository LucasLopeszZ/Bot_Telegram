import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const binPath = path.join(__dirname, '..', 'node_modules', '.bin', 'vite');

if (fs.existsSync(binPath)) {
  try {
    fs.chmodSync(binPath, 0o755);
  } catch (error) {
    // Ignora falhas em ambientes Windows/sem suporte a chmod
  }
}

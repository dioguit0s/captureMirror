// Copia as dependências do renderer para dentro de src/: o WebView2 só enxerga
// a pasta servida pelo Tauri, não o node_modules.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = [['node_modules/mediabunny/dist/bundles/mediabunny.min.mjs', 'src/renderer/vendor/mediabunny.min.mjs']];

for (const [from, to] of files) {
  mkdirSync(dirname(join(root, to)), { recursive: true });
  copyFileSync(join(root, from), join(root, to));
}

// Entry point for `node --import ./tests/stubs/register.mjs <script>`.
// Aliases the plugin's @deepseek-ai/* imports to the local stubs in this folder.
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);

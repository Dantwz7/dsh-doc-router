// Entry point for `node --import ./tests/manual/real-register.mjs <script>`.
// Points the plugin's @deepseek-ai/* imports at the real packages in app.asar.
import { register } from 'node:module';

register('./real-loader.mjs', import.meta.url);

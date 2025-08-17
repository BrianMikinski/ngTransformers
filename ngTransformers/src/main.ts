import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

// env.allowLocalModels = false;
// env.backends.onnx.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@latest/dist/wasm/';

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));

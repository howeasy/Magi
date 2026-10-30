// `magi serve codex`: the codex adapter, served. Importing the adapter
// alone (fleet.mjs, tests) starts nothing.
import { serve } from './serve.mjs';
import { adapter } from './codex-adapter.mjs';

await serve(adapter);

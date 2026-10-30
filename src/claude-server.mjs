// `magi serve claude`: the claude adapter, served. Importing the adapter
// alone (fleet.mjs, tests) starts nothing.
import { serve } from './serve.mjs';
import { adapter } from './claude-adapter.mjs';

await serve(adapter);

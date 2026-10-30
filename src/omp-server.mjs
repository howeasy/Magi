// `magi serve omp`: the omp adapter, served. Importing the adapter
// alone (fleet.mjs, tests) starts nothing.
import { serve } from './serve.mjs';
import { adapter } from './omp-adapter.mjs';

await serve(adapter);

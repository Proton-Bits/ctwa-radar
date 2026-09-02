// Alias de compatibilidade: a API mora em routes/v1/.
// Serve o mesmo router em /api, para nao quebrar quem ja aponta para la.
export { router } from './v1/index.js';

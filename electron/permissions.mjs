export const PERMISSION_MODES = Object.freeze(['ask', 'auto-edits', 'full']);

// Unknown persisted values must never become a grant of additional access.
export function normalizePermissionMode(value) {
  return PERMISSION_MODES.includes(value) ? value : 'ask';
}

export function validatePermissionMode(value) {
  if (!PERMISSION_MODES.includes(value)) throw new Error('Permission mode must be ask, auto-edits, or full.');
  return value;
}

export function validatePermissionTransition(previous, next, confirmation) {
  validatePermissionMode(next);
  if (confirmation !== undefined && typeof confirmation !== 'boolean') throw new Error('Full access confirmation must be true or false.');
  if (next === 'full' && previous !== 'full' && confirmation !== true) {
    throw new Error('Confirm full access before enabling automatic file changes and shell commands.');
  }
}

export function autoApproves(mode, type) {
  return (mode === 'full' && ['write', 'command'].includes(type)) || (mode === 'auto-edits' && type === 'write');
}

export function permissionDescription(mode) {
  if (mode === 'full') return 'Full access: file changes and shell commands run automatically, without asking for approval. File tools remain scoped to the project; shell commands use the user’s OS permissions and can access other files and the network.';
  if (mode === 'auto-edits') return 'Approve file edits: project file changes run automatically. Every shell command still requires explicit user approval.';
  return 'Ask for approval: every file change and shell command requires explicit user approval.';
}

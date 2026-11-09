const STORAGE_KEY = 'datastorm.consumer.registration-draft.v1';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
let writes = Promise.resolve();

function enqueue(operation) {
  const pending = writes.then(operation);
  writes = pending.catch(() => {});
  return pending;
}

export async function readRegistrationDraft(storage, now = Date.now()) {
  await writes;
  const raw = await storage.getItemAsync(STORAGE_KEY);
  if (!raw) return null;

  let draft;
  try {
    draft = JSON.parse(raw);
  } catch {
    await storage.deleteItemAsync(STORAGE_KEY);
    return null;
  }

  const valid = draft && typeof draft.email === 'string' && draft.email.length <= 254 &&
    ['email', 'details'].includes(draft.step) && typeof draft.marketingOptIn === 'boolean' &&
    typeof draft.termsVersion === 'string' && typeof draft.privacyVersion === 'string' &&
    Number.isFinite(draft.savedAt) && draft.savedAt <= now + 5 * 60 * 1000 &&
    now - draft.savedAt <= MAX_AGE_MS;
  if (!valid) {
    await storage.deleteItemAsync(STORAGE_KEY);
    return null;
  }

  return {
    email: draft.email,
    step: draft.step,
    marketingOptIn: draft.marketingOptIn,
    termsVersion: draft.termsVersion,
    privacyVersion: draft.privacyVersion
  };
}

export async function writeRegistrationDraft(storage, draft, now = Date.now()) {
  const saved = {
    email: draft.email.trim().slice(0, 254),
    step: draft.step,
    marketingOptIn: draft.marketingOptIn,
    termsVersion: draft.termsVersion,
    privacyVersion: draft.privacyVersion,
    savedAt: now
  };
  await enqueue(() => storage.setItemAsync(STORAGE_KEY, JSON.stringify(saved)));
}

export async function clearRegistrationDraft(storage) {
  await enqueue(() => storage.deleteItemAsync(STORAGE_KEY));
}

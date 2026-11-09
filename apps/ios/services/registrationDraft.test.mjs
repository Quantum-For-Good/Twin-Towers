import test from 'node:test';
import assert from 'node:assert/strict';
import { clearRegistrationDraft, readRegistrationDraft, writeRegistrationDraft } from './registrationDraft.mjs';

function fixture() {
  let value = null;
  return {
    storage: {
      async getItemAsync() { return value; },
      async setItemAsync(_key, next) { value = next; },
      async deleteItemAsync() { value = null; }
    },
    get value() { return value; },
    set value(next) { value = next; }
  };
}

const draft = {
  email: ' person@example.test ',
  step: 'details',
  marketingOptIn: true,
  termsVersion: 'terms-1',
  privacyVersion: 'privacy-1'
};

test('registration draft resumes without persisting passwords or legal acceptance', async () => {
  const f = fixture();
  await writeRegistrationDraft(f.storage, draft, 1000);
  assert.deepEqual(await readRegistrationDraft(f.storage, 2000), {
    email: 'person@example.test',
    step: 'details',
    marketingOptIn: true,
    termsVersion: 'terms-1',
    privacyVersion: 'privacy-1'
  });
  assert.doesNotMatch(f.value, /password|legalAccepted/i);
});

test('expired or malformed registration drafts are removed', async () => {
  const f = fixture();
  await writeRegistrationDraft(f.storage, draft, 0);
  assert.equal(await readRegistrationDraft(f.storage, 31 * 24 * 60 * 60 * 1000), null);
  assert.equal(f.value, null);
  f.value = '{';
  assert.equal(await readRegistrationDraft(f.storage), null);
  assert.equal(f.value, null);
});

test('registration draft can be explicitly discarded', async () => {
  const f = fixture();
  await writeRegistrationDraft(f.storage, draft);
  await clearRegistrationDraft(f.storage);
  assert.equal(await readRegistrationDraft(f.storage), null);
});

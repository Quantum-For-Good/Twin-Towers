export interface RegistrationDraft {
  email: string;
  step: 'email' | 'details';
  marketingOptIn: boolean;
  termsVersion: string;
  privacyVersion: string;
}

export interface RegistrationDraftStorage {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export function readRegistrationDraft(storage: RegistrationDraftStorage, now?: number): Promise<RegistrationDraft | null>;
export function writeRegistrationDraft(storage: RegistrationDraftStorage, draft: RegistrationDraft, now?: number): Promise<void>;
export function clearRegistrationDraft(storage: RegistrationDraftStorage): Promise<void>;

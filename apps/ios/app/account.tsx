import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, findNodeHandle, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { BrandHeader, Card, Screen, colors, ui } from '../components/Brand';
import { useSession } from '../components/SessionProvider';
import { SessionError } from '../services/sessionCore';
import { clearRegistrationDraft, readRegistrationDraft, writeRegistrationDraft } from '../services/registrationDraft.mjs';

export default function Account() {
  return <ConsumerAccount />;
}
function ConsumerAccount() {
  const { manager, user, ready, restoreError, sessionWarning } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'signin' | 'create'>('signin');
  const [step, setStep] = useState<'email' | 'details'>('email');
  const [legalAccepted, setLegalAccepted] = useState(false);
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const termsVersion = process.env.EXPO_PUBLIC_TERMS_VERSION ?? '';
  const privacyVersion = process.env.EXPO_PUBLIC_PRIVACY_VERSION ?? '';
  const [error, setError] = useState<string | null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [saveProgress, setSaveProgress] = useState(false);
  const [policyReviewRequired, setPolicyReviewRequired] = useState(false);
  const errorRef = useRef<View>(null);
  useEffect(() => {
    if (Platform.OS === 'web') {
      setDraftReady(true);
      return;
    }
    let active = true;
    void readRegistrationDraft(SecureStore).then(draft => {
      if (!active || !draft) return;
      setEmail(draft.email);
      setMarketingOptIn(draft.marketingOptIn);
      setMode('create');
      setDraftSaved(true);
      setSaveProgress(true);
      if (draft.termsVersion === termsVersion && draft.privacyVersion === privacyVersion) {
        setStep(draft.step);
      } else setPolicyReviewRequired(true);
    }).catch(() => {
      if (active) setError('Saved registration progress could not be loaded. You can start again.');
    }).finally(() => {
      if (active) setDraftReady(true);
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!draftReady || mode !== 'create' || !saveProgress || Platform.OS === 'web') return;
    setDraftSaved(false);
    const timer = setTimeout(() => {
      void writeRegistrationDraft(SecureStore, {
        email, step, marketingOptIn, termsVersion, privacyVersion
      }).then(() => setDraftSaved(true)).catch(() => setDraftSaved(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [draftReady, mode, saveProgress, email, step, marketingOptIn, termsVersion, privacyVersion]);
  useEffect(() => {
    if (!error) return;
    const tag = findNodeHandle(errorRef.current);
    if (tag !== null) AccessibilityInfo.setAccessibilityFocus(tag);
  }, [error]);
  const act = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); }
    catch (failure) { setError(failure instanceof SessionError ? failure.message : 'Account access is unavailable. Try again.'); }
    finally { setPassword(''); setBusy(false); }
  };
  const continueRegistration = () => {
    setError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('Enter a valid email address to continue.');
      return;
    }
    setStep('details');
  };
  return <Screen>
    <BrandHeader section="DataStorm account" />
    <Text style={ui.title}>Your account. Your choices.</Text>
    <Text style={ui.body}>Use your existing DataStorm account to access KICK’S. Signing in does not authorize monitoring or data sharing.</Text>
    {!ready ? <Card><ActivityIndicator color={colors.orange} /><Text style={ui.body}>Checking your session…</Text></Card> : user ? <Card>
      <Text style={ui.h2}>Signed in</Text><Text style={ui.body}>{user.email}</Text>
      <Pressable disabled={busy} onPress={() => router.replace('/profile')}><Text style={s.link}>Open my profile</Text></Pressable>
      <Pressable disabled={busy} onPress={() => router.push('/permissions')}><Text style={s.link}>Review permissions</Text></Pressable>
      <Pressable disabled={busy} onPress={() => act(() => manager.logout())}><Text style={s.link}>Sign out</Text></Pressable>
    </Card> : <Card>
      <Text style={ui.h2}>{mode === 'create' ? 'Create your DataStorm account' : 'Sign in to DataStorm'}</Text>
      {mode === 'create' && <Text accessibilityRole="progressbar" accessibilityValue={{ min: 1, max: 2, now: step === 'email' ? 1 : 2, text: step === 'email' ? 'Step 1 of 2' : 'Step 2 of 2' }} accessibilityLiveRegion="polite" style={ui.body}>
        Step {step === 'email' ? '1 of 2: Your email' : '2 of 2: Secure your account'}
      </Text>}
      {mode === 'create' && policyReviewRequired && <Text accessibilityRole="alert" style={ui.body}>The Terms or Privacy Notice changed. Review them again before creating your account.</Text>}
      {(mode === 'signin' || step === 'email') && <>
        <Text style={ui.label}>EMAIL</Text>
        <TextInput accessibilityLabel="Email address" accessibilityHint="Enter the email address for your DataStorm account" style={s.input} value={email} onChangeText={setEmail} maxLength={254} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email" editable={!busy} placeholder="Your email" placeholderTextColor={colors.muted} returnKeyType={mode === 'create' ? 'next' : 'done'} onSubmitEditing={() => mode === 'create' && continueRegistration()} />
      </>}
      {(mode === 'signin' || step === 'details') && <>
        {mode === 'create' && <Text style={ui.body}>Creating an account for {email.trim()}</Text>}
        <Text style={ui.label}>PASSWORD</Text>
        <TextInput accessibilityLabel="Password" accessibilityHint={mode === 'create' ? 'Choose a password with at least 12 characters' : 'Enter your DataStorm account password'} style={s.input} value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete={mode === 'create' ? 'new-password' : 'current-password'} editable={!busy} placeholder="Your password" placeholderTextColor={colors.muted} />
      </>}
      {mode === 'create' && step === 'details' && <>
        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: legalAccepted }} disabled={busy}
          onPress={() => setLegalAccepted(value => !value)}>
          <Text style={s.link}>{legalAccepted ? '☑' : '☐'} I agree to the DataStorm Terms and Privacy Notice.</Text>
        </Pressable>
        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: marketingOptIn }} disabled={busy}
          onPress={() => setMarketingOptIn(value => !value)}>
          <Text style={s.link}>{marketingOptIn ? '☑' : '☐'} Send me optional DataStorm product updates.</Text>
        </Pressable>
      </>}
      <Pressable accessibilityRole="button"
        accessibilityLabel={mode === 'create' && step === 'email' ? 'Continue to account security' : mode === 'create' ? 'Create DataStorm account' : 'Sign in'}
        disabled={busy || (mode === 'create' && step === 'email' ? false : (!email.trim() || !password)) || (mode === 'create' && step === 'details' && (!legalAccepted || password.length < 12 || !termsVersion || !privacyVersion))}
        onPress={() => {
          setError(null);
          if (mode === 'create' && step === 'email') {
            continueRegistration();
            return;
          }
          void act(async () => {
            if (mode === 'create') {
              await manager.register(email, password, { termsVersion, privacyVersion, marketingOptIn });
              await clearRegistrationDraft(SecureStore).catch(() => {});
              setSaveProgress(false);
            } else {
              await manager.login(email, password);
            }
            router.replace('/profile');
          });
        }}>
        <Text style={s.link}>{busy ? (mode === 'create' ? 'Creating account…' : 'Signing in…') : mode === 'create' && step === 'email' ? 'Continue' : mode === 'create' ? 'Create account' : 'Sign in'}</Text>
      </Pressable>
      {mode === 'create' && step === 'details' && <Pressable accessibilityRole="button" disabled={busy} onPress={() => setStep('email')}><Text style={s.link}>Back to email</Text></Pressable>}
      {mode === 'create' && (!termsVersion || !privacyVersion) &&
        <Text accessibilityRole="alert" style={ui.body}>Account registration is disabled until this build is configured with the current Terms and Privacy versions.</Text>}
      {mode === 'create' && Platform.OS !== 'web' && <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: saveProgress }} disabled={busy} onPress={() => {
        const next = !saveProgress;
        setSaveProgress(next);
        if (!next) void clearRegistrationDraft(SecureStore).then(() => setDraftSaved(false))
          .catch(() => setError('Saved progress could not be removed. Try again.'));
      }}>
        <Text style={s.link}>{saveProgress ? '☑' : '☐'} Save my email and setup step securely on this device to resume later</Text>
      </Pressable>}
      {mode === 'create' && saveProgress && Platform.OS !== 'web' && <Text accessibilityLiveRegion="polite" style={ui.body}>{draftSaved ? 'Progress saved. Your password and consent choice are never saved.' : 'Saving your progress securely on this device…'}</Text>}
      {mode === 'signin' && draftSaved && Platform.OS !== 'web' && <Text style={ui.body}>Your account setup progress is saved on this device. Choose “Create an account” to continue.</Text>}
      {mode === 'create' && draftSaved && Platform.OS !== 'web' && <Pressable accessibilityRole="button" disabled={busy} onPress={() => {
        void clearRegistrationDraft(SecureStore).then(() => {
          setEmail(''); setPassword(''); setMarketingOptIn(false); setLegalAccepted(false);
          setStep('email'); setDraftSaved(false); setMode('signin');
        }).catch(() => setError('Saved progress could not be removed. Try again.'));
      }}><Text style={s.link}>Discard saved progress</Text></Pressable>}
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => {
        setError(null);
        setLegalAccepted(false);
        if (mode === 'create' && Platform.OS !== 'web') {
          void writeRegistrationDraft(SecureStore, { email, step, marketingOptIn, termsVersion, privacyVersion }).then(() => {
            setDraftSaved(true);
            setSaveProgress(true);
            setMode('signin');
          }).catch(() => setError('Progress could not be saved. Stay here and try again.'));
        } else {
          setMode(mode === 'create' ? 'signin' : 'create');
          if (mode === 'signin') setStep('email');
        }
      }}>
        <Text style={s.link}>{mode === 'create' ? Platform.OS === 'web' ? 'Return to sign in' : 'Save and return to sign in' : 'New to DataStorm? Create an account'}</Text>
      </Pressable>
      <Text style={ui.body}>Signing in or creating an account does not authorize monitoring or data sharing.</Text>
    </Card>}
    {(error || sessionWarning || (!user && restoreError)) && <Card>
      <View ref={errorRef} accessible accessibilityRole="alert" accessibilityLabel={error ?? sessionWarning ?? restoreError ?? undefined} accessibilityLiveRegion="assertive">
        <Text accessibilityRole="alert" style={ui.body}>{error ?? sessionWarning ?? restoreError}</Text>
      </View>
      {sessionWarning?.startsWith('Secure storage') && <Pressable accessibilityRole="button" disabled={busy} onPress={() => act(() => manager.logout())}><Text style={s.link}>Retry sign out</Text></Pressable>}
    </Card>}
    {busy && <View><ActivityIndicator color={colors.orange} /></View>}
    <Pressable onPress={() => router.push('/settings')}><Text style={s.link}>Back to Settings</Text></Pressable>
  </Screen>;
}
const s = StyleSheet.create({
  input: { color: colors.text, borderWidth: 1, borderColor: '#493a32', borderRadius: 10, padding: 12, fontSize: 16 },
  link: { color: colors.orange, fontSize: 16, fontWeight: '700', paddingVertical: 12 }
});

import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { exampleValue, initialSelection, selectedCategories, type Selection } from './model.mjs';

type Screen = 'ask' | 'modify' | 'receipt';
const choices: { key: keyof Selection; title: string; value: string }[] = [
  { key: 'distance', title: 'Distance & pace', value: '$0.90' },
  { key: 'routes', title: 'Exact map routes', value: '$0.70' },
  { key: 'shoe', title: 'Shoe type', value: '$0.90' }
];

export function ConsentPreview() {
  const [open, setOpen] = useState(false);
  const [screen, setScreen] = useState<Screen>('ask');
  const [selection, setSelection] = useState<Selection>({ ...initialSelection });
  const [privacy, setPrivacy] = useState(5);
  const [exampleRevoked, setExampleRevoked] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const close = () => {
    setOpen(false);
    setScreen('ask');
    setSelection({ ...initialSelection });
    setPrivacy(5);
    setExampleRevoked(false);
    setDetailsOpen(true);
  };

  return <>
    <Pressable accessibilityRole="button" accessibilityLabel="Open example consent request" onPress={() => setOpen(true)} style={s.floating}>
      <Text style={s.floatingText}>ASK</Text>
    </Pressable>
    <Modal visible={open} transparent animationType="slide" onRequestClose={close}>
      <View style={s.scrim}>
        <View style={s.sheet} accessibilityViewIsModal>
          <View style={s.header}>
            <View style={s.grow}><Text style={s.kicker}>KICK&apos;S · CONSENT IS TRUST</Text><Text style={s.title}>{screen === 'ask' ? 'Your data, your decision.' : screen === 'modify' ? 'Make it yours.' : 'Example receipt'}</Text></View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close consent example" onPress={close} style={s.close}><Text style={s.closeText}>×</Text></Pressable>
          </View>
          <ScrollView contentContainerStyle={s.content}>
            <View style={s.notice}><Text style={s.noticeText}>EXAMPLE ONLY · No request is sent, no data is shared and no consent is recorded.</Text></View>
            {screen === 'ask' && <>
              <Text style={s.body}>A sample shoe recommendation request for 12 runs. Choose what you would share before deciding.</Text>
              <View style={s.card}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Example request details"
                  accessibilityState={{ expanded: detailsOpen }}
                  aria-expanded={detailsOpen}
                  onPress={() => setDetailsOpen(current => !current)}
                  style={s.row}
                >
                  <View style={s.grow}>
                    <Text style={s.label}>ILLUSTRATIVE PARTNER · NIKE</Text>
                    <Text style={s.cardTitle}>Personalized shoe recommendation</Text>
                  </View>
                  <Text style={s.chevron}>{detailsOpen ? '−' : '+'}</Text>
                </Pressable>
                {detailsOpen && <>
                  <Text style={s.body}>Example: 12 runs, ${exampleValue(selection)} credit, 24-hour access followed by automatic revocation.</Text>
                  <Text style={s.small}>Example verified badge · This is not a verified live offer.</Text>
                </>}
              </View>
              <Text style={s.label}>$5 OPPORTUNITY LABEL · EXAMPLE</Text>
              <Text style={s.small}>Amounts and partners are illustrative, not an offer or earnings promise. Granting consent never starts monitoring.</Text>
              <View style={s.actions}>
                <Button label="Decline" onPress={close} secondary />
                <Button label="Modify" onPress={() => setScreen('modify')} secondary />
              </View>
              <Button label="Allow Once unavailable" disabled onPress={() => {}} />
              <Text accessibilityRole="alert" style={s.small}>Real consent is unavailable until secure enrollment and automatic expiry are supported.</Text>
              <Button label="Preview an example receipt" onPress={() => { setExampleRevoked(false); setScreen('receipt'); }} secondary />
            </>}
            {screen === 'modify' && <>
              <Text style={s.body}>Explore the sample choices. These switches do not change your permissions.</Text>
              <View style={s.card}>
                {choices.map(({ key, title, value }) => <View key={key} style={s.row}>
                  <View style={s.grow}><Text style={s.rowTitle}>{title}</Text><Text style={s.small}>Example value {value}</Text></View>
                  <Switch accessibilityLabel={title} value={selection[key]} onValueChange={value => setSelection(current => ({ ...current, [key]: value }))} trackColor={{ false: '#cbd5e1', true: '#2563eb' }} />
                </View>)}
              </View>
              <Text style={s.cardTitle}>Example value: ${exampleValue(selection)}</Text>
              <Text style={s.small}>Values are illustrative only; sharing more does not create an entitlement to a reward.</Text>
              <Text style={s.cardTitle}>Privacy–Value preference</Text>
              <Text style={s.small}>Example preference: {privacy} of 10. This does not change consent or data sharing.</Text>
              <View accessibilityRole="adjustable" accessibilityLabel="Example privacy value preference" accessibilityValue={{ min: 0, max: 10, now: privacy }} accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]} onAccessibilityAction={event => {
                if (event.nativeEvent.actionName === 'increment') setPrivacy(value => Math.min(10, value + 1));
                if (event.nativeEvent.actionName === 'decrement') setPrivacy(value => Math.max(0, value - 1));
              }} style={s.slider}>
                {Array.from({ length: 11 }, (_, i) => <Pressable key={i} accessibilityRole="button" accessibilityLabel={`Set example preference to ${i}`} onPress={() => setPrivacy(i)} style={[s.segment, i <= privacy && s.segmentActive]} />)}
              </View>
              <View style={s.actions}><Text style={s.small}>More privacy</Text><Text style={s.small}>More value</Text></View>
              <Button label="Back to Ask" onPress={() => setScreen('ask')} />
            </>}
            {screen === 'receipt' && <>
              <View style={s.card}>
                <Text style={s.label}>EXAMPLE · NOT A REAL RECEIPT</Text>
                <Text style={s.cardTitle}>12 sample runs</Text>
                <Text style={s.body}>Sample fields: {selectedCategories(selection).join(', ') || 'none selected'}.</Text>
                <Text style={s.body}>Example ledger entry #4821 · ${exampleValue(selection)} credit</Text>
                <Text style={s.small}>No runs were shared and no ledger entry was created.</Text>
                {exampleRevoked && <Text accessibilityLiveRegion="polite" style={s.label}>EXAMPLE REVOKED · SIMULATION ONLY</Text>}
              </View>
              <Button label="Revoke Now unavailable" disabled onPress={() => {}} />
              <Text style={s.small}>Real revocation will be available when an actual consent decision exists.</Text>
              <Button label="Simulate revocation" disabled={exampleRevoked} onPress={() => setExampleRevoked(true)} secondary />
              <Button label="Back to Ask" onPress={() => setScreen('ask')} secondary />
            </>}
          </ScrollView>
        </View>
      </View>
    </Modal>
  </>;
}

function Button({ label, onPress, secondary = false, disabled = false }: { label: string; onPress: () => void; secondary?: boolean; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[s.button, secondary && s.secondary, disabled && s.disabled]}>
    <Text style={[s.buttonText, secondary && s.secondaryText]}>{label}</Text>
  </Pressable>;
}

const s = StyleSheet.create({
  floating: { position: 'absolute', right: 18, bottom: 82, backgroundColor: '#111827', borderRadius: 28, paddingHorizontal: 22, height: 50, justifyContent: 'center', elevation: 8, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
  floatingText: { color: '#fff', fontSize: 13, fontWeight: '800', letterSpacing: 1 },
  scrim: { flex: 1, backgroundColor: 'rgba(15,23,42,0.55)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#f6f8fc', borderTopLeftRadius: 28, borderTopRightRadius: 28, maxHeight: '90%', width: '100%', maxWidth: 600, alignSelf: 'center' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingHorizontal: 22, paddingTop: 22, gap: 12 },
  kicker: { color: '#2563eb', fontWeight: '800', fontSize: 10, letterSpacing: 1 },
  title: { color: '#111827', fontWeight: '800', fontSize: 25, marginTop: 5 },
  close: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20, backgroundColor: '#e8eef8' },
  closeText: { color: '#111827', fontSize: 26 },
  content: { padding: 22, paddingBottom: 38, gap: 14 },
  notice: { backgroundColor: '#e8efff', borderRadius: 12, padding: 12 },
  noticeText: { color: '#1e40af', fontSize: 12, fontWeight: '700', lineHeight: 18 },
  card: { backgroundColor: '#fff', borderRadius: 18, borderWidth: 1, borderColor: '#e6eaf1', padding: 18, gap: 10 },
  label: { color: '#2563eb', fontSize: 11, fontWeight: '800', letterSpacing: 0.7 },
  cardTitle: { color: '#111827', fontSize: 18, fontWeight: '700' },
  body: { color: '#475569', fontSize: 15, lineHeight: 22 },
  small: { color: '#64748b', fontSize: 12, lineHeight: 18 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  grow: { flex: 1 },
  chevron: { color: '#2563eb', fontSize: 24, fontWeight: '600', minWidth: 28, textAlign: 'center' },
  rowTitle: { color: '#111827', fontWeight: '700', fontSize: 15 },
  actions: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  button: { minHeight: 48, borderRadius: 12, backgroundColor: '#111827', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, flexGrow: 1 },
  secondary: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#d8e0ec' },
  disabled: { backgroundColor: '#94a3b8' },
  buttonText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  secondaryText: { color: '#111827' },
  slider: { flexDirection: 'row', gap: 4, paddingVertical: 10 },
  segment: { flex: 1, height: 24, borderRadius: 6, backgroundColor: '#dce4ef' },
  segmentActive: { backgroundColor: '#2563eb' }
});

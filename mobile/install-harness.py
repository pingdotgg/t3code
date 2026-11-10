from pathlib import Path
for side in ['before','after']:
 root=Path('/home/ubuntu/wt/pr-33577-mobile-'+side)
 p=root/'apps/mobile/src/features/threads/ThreadFeed.tsx'
 s=p.read_text().replace('\nfunction RunFoldButton({','\nexport function RunFoldButton({')
 p.write_text(s)
 # App imports are activated only after real-app capture.
 template=Path('/tmp/lead-33577-r2/mobile/scripts/CaptureHarness.tsx').read_text()
 if side=='after':
  template=template.replace('// TIMER_IMPORT',"import {activeWorkTimerStartedAt as resolveCaptureTimer} from '@t3tools/client-runtime/user-wait';")
 else:
  template=template.replace('// TIMER_IMPORT',"const resolveCaptureTimer=(input:{runStartedAt:string|null;runlessStartedAt:string|null;items:unknown[]})=>input.runStartedAt??input.runlessStartedAt;")
 (root/'apps/mobile/src/CaptureHarness.tsx').write_text(template)
 p=root/'apps/mobile/src/App.tsx';s=p.read_text();s="import CaptureHarness, {CAPTURE_ENABLED} from './CaptureHarness';\n"+s if 'import CaptureHarness' not in s else s;s=s.replace('<AppContent />','{CAPTURE_ENABLED ? <CaptureHarness /> : <AppContent />}');p.write_text(s)
 p=root/'apps/mobile/src/features/threads/use-visible-second-clock.ts';s=p.read_text();s=s.replace('export function useVisibleSecondClock(enabled: boolean): number {','export function useVisibleSecondClock(enabled: boolean): number {\n  if ((globalThis as any).__captureNow !== undefined) return (globalThis as any).__captureNow;');p.write_text(s)

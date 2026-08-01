import AsyncStorage from '@react-native-async-storage/async-storage';
import { Camera } from 'expo-camera';
import * as FileSystem from 'expo-file-system/legacy';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Sharing from 'expo-sharing';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import Svg, { Circle, Line, Path, Polyline, Rect } from 'react-native-svg';
import {
  Alert,
  Animated,
  Dimensions,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import HeartRatePpgModule from './modules/heart-rate-ppg/src/HeartRatePpgModule';
import type { PpgUpdatePayload } from './modules/heart-rate-ppg/src/HeartRatePpg.types';

type Measurement = {
  id: string;
  metric: MetricKey;
  label: string;
  value: number;
  unit: string;
  bpm: number;
  spO2?: number;
  respiration?: number;
  hrv?: number;
  stress?: string;
  quality: number;
  durationMs: number;
  createdAt: string;
  activity?: string;
  note?: string;
};

type MetricKey = 'heartRate' | 'spo2' | 'respiration' | 'hrv' | 'stress';
type TabKey = 'measure' | 'history' | 'stats' | 'settings';
type RouteKey = 'main' | 'guide' | 'finger' | 'result' | 'detail' | 'reminder' | 'export' | 'empty-history';
type DebugEntry = { at: string; code: string; data?: unknown };
type HistoryPeriod = 'day' | 'week' | 'month';
type Language = 'vi' | 'en';

const STORAGE_KEY = 'donhiptim.measurements.v2';
const CONSENT_KEY = 'donhiptim.consent.v1';
const LANGUAGE_KEY = 'donhiptim.language.v1';
const screenWidth = Dimensions.get('window').width;
const dialSize = Math.min(screenWidth - 88, 280);
const rose = '#f34f75';
const roseDark = '#c92d52';
const navy = '#04192a';
const navy2 = '#08243a';
const ink = '#111827';
const muted = '#667085';
const line = '#e8edf3';
const KEEP_AWAKE_TAG = 'heart-rate-measurement';
const LOG_KEY = 'donhiptim.debug.logs.v1';

const healthMetrics: { key: MetricKey; label: string; short: string; unit: string; icon: string; color: string; description: string }[] = [
  { key: 'heartRate', label: 'Nhịp tim', short: 'Nhịp tim (BPM)', unit: 'BPM', icon: '♥', color: rose, description: 'Đo nhịp tim từ tín hiệu camera.' },
  { key: 'spo2', label: 'SpO2', short: 'SpO2', unit: '%', icon: '♢', color: '#2f80ed', description: 'Ước tính độ bão hòa oxy trong máu.' },
  { key: 'respiration', label: 'Nhịp thở', short: 'Nhịp thở', unit: 'RPM', icon: '♒', color: '#38bdf8', description: 'Theo dõi tốc độ thở từ nhịp biến thiên.' },
  { key: 'hrv', label: 'HRV', short: 'HRV', unit: 'ms', icon: '↯', color: '#22c55e', description: 'Độ biến thiên nhịp tim tham khảo.' },
  { key: 'stress', label: 'Căng thẳng', short: 'Căng thẳng', unit: '', icon: '☺', color: '#f59e0b', description: 'Đánh giá căng thẳng từ nhịp tim.' },
];

const initialUpdate: PpgUpdatePayload = {
  status: 'idle',
  elapsedMs: 0,
  progress: 0,
  quality: 0,
};

const demoHistory: Measurement[] = [
  makeDemo('demo-1', 'heartRate', 78, 'BPM', 78, 0),
  makeDemo('demo-2', 'spo2', 98, '%', 72, 2),
  makeDemo('demo-3', 'respiration', 16, 'RPM', 85, 15),
  makeDemo('demo-4', 'stress', 1, '', 92, 18),
  makeDemo('demo-5', 'hrv', 42, 'ms', 65, 44),
];

export default function App() {
  const [accepted, setAccepted] = useState(false);
  const [onboardPage, setOnboardPage] = useState(0);
  const [activeTab, setActiveTab] = useState<TabKey>('measure');
  const [route, setRoute] = useState<RouteKey>('main');
  const [selected, setSelected] = useState<Measurement | undefined>();
  const [pendingResult, setPendingResult] = useState<Measurement | undefined>();
  const [selectedMetric, setSelectedMetric] = useState<MetricKey>('heartRate');
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [update, setUpdate] = useState<PpgUpdatePayload>(initialUpdate);
  const [finalBpm, setFinalBpm] = useState<number | undefined>();
  const [liveBpm, setLiveBpm] = useState<number | undefined>();
  const [pendingNoteId, setPendingNoteId] = useState<string | undefined>();
  const [noteText, setNoteText] = useState('');
  const [activity, setActivity] = useState('Sau tập');
  const [signalHistory, setSignalHistory] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [reminderOn, setReminderOn] = useState(false);
  const [themeLight, setThemeLight] = useState(true);
  const [language, setLanguageState] = useState<Language>('vi');
  const [debugLogs, setDebugLogs] = useState<DebugEntry[]>([]);
  const measurementsRef = useRef<Measurement[]>([]);
  const debugLogsRef = useRef<DebugEntry[]>([]);
  const selectedMetricRef = useRef<MetricKey>('heartRate');
  const failResetRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastGoodUpdateRef = useRef<PpgUpdatePayload | undefined>(undefined);
  const measurementSavedRef = useRef(false);
  const routeRef = useRef<RouteKey>('main');
  const beatTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    measurementsRef.current = measurements;
  }, [measurements]);

  useEffect(() => {
    debugLogsRef.current = debugLogs;
  }, [debugLogs]);

  useEffect(() => {
    selectedMetricRef.current = selectedMetric;
  }, [selectedMetric]);

  useEffect(() => {
    routeRef.current = route;
  }, [route]);

  useEffect(() => {
    const subscription = HeartRatePpgModule.addListener('onPpgUpdate', (event: PpgUpdatePayload) => {
      void appendDebugLog('PPG_EVENT', {
        status: event.status,
        bpm: event.bpm,
        progress: event.progress,
        quality: event.quality,
        elapsedMs: event.elapsedMs,
        metric: selectedMetricRef.current,
        route: routeRef.current,
        message: event.message,
      });
      if (event.status !== 'failed' && failResetRef.current) {
        clearTimeout(failResetRef.current);
        failResetRef.current = undefined;
      }
      setUpdate(event);
      if ((event.status === 'warming' || event.status === 'measuring') && typeof event.signal === 'number') {
        setFinalBpm(undefined);
        setSignalHistory((items) => [...items.slice(-58), event.signal!]);
      }
      if ((event.status === 'warming' || event.status === 'measuring') && event.bpm) {
        setLiveBpm(event.bpm);
        lastGoodUpdateRef.current = event;
      }
      if (event.status === 'complete') {
        const completed = completeEventWithFallback(event);
        if (!completed.bpm) {
          showDebugError('COMPLETE_WITHOUT_BPM', { event, lastGood: lastGoodUpdateRef.current });
          return;
        }
        setFinalBpm(completed.bpm);
        setLiveBpm(undefined);
        lastGoodUpdateRef.current = completed;
        completeMeasurement(completed);
      }
      if (event.status === 'failed' || event.status === 'stopped') {
        setLiveBpm(undefined);
        const lastGood = lastGoodUpdateRef.current;
        if (!measurementSavedRef.current && lastGood?.bpm && (lastGood.elapsedMs >= 12000 || event.progress >= 0.9)) {
          completeMeasurement({
            ...lastGood,
            status: 'complete',
            progress: 1,
            message: `${event.status}: saved from last stable BPM`,
          });
          return;
        }
        if (!measurementSavedRef.current) {
          setFinalBpm(undefined);
        }
      }
      if (event.status === 'failed') {
        showDebugError('PPG_FAILED', event);
        failResetRef.current = setTimeout(() => {
          setUpdate((current) => current.status === 'failed' ? initialUpdate : current);
          failResetRef.current = undefined;
        }, 1800);
      }
    });
    return () => {
      if (failResetRef.current) clearTimeout(failResetRef.current);
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    const subscription = HeartRatePpgModule.addListener('onScreenshotTaken', (event: { at: string }) => {
      void (async () => {
        await appendDebugLog('SCREENSHOT_TAKEN', { at: event.at, route: routeRef.current });
        await shareDebugLog();
      })();
    });
    return () => subscription.remove();
  }, []);

  const latest = measurements[0];
  const history = measurements.length > 0 ? measurements : demoHistory;
  const isMeasuring = update.status === 'warming' || update.status === 'measuring';
  const visibleBpm = isMeasuring ? liveBpm : update.status === 'complete' ? finalBpm : undefined;
  const progressValue = Math.max(0, Math.min(update.progress, 1));

  useEffect(() => {
    if (isMeasuring) {
      void activateKeepAwakeAsync(KEEP_AWAKE_TAG);
    } else {
      deactivateKeepAwake(KEEP_AWAKE_TAG);
    }
    return () => {
      void deactivateKeepAwake(KEEP_AWAKE_TAG);
    };
  }, [isMeasuring]);

  useEffect(() => {
    if (beatTimerRef.current) {
      clearTimeout(beatTimerRef.current);
      beatTimerRef.current = undefined;
    }
    if (!isMeasuring || !liveBpm || liveBpm < 40 || selectedMetric !== 'heartRate') return;
    let cancelled = false;
    const scheduleBeat = () => {
      if (cancelled) return;
      const bpm = Math.max(45, Math.min(180, liveBpm));
      void HeartRatePpgModule.playBeatAsync();
      beatTimerRef.current = setTimeout(scheduleBeat, 60000 / bpm);
    };
    scheduleBeat();
    return () => {
      cancelled = true;
      if (beatTimerRef.current) {
        clearTimeout(beatTimerRef.current);
        beatTimerRef.current = undefined;
      }
    };
  }, [isMeasuring, liveBpm, selectedMetric]);

  const stats = useMemo(() => {
    const items = history;
    const bpms = items.map((item) => item.bpm);
    const avg = Math.round(bpms.reduce((sum, item) => sum + item, 0) / Math.max(bpms.length, 1));
    return {
      avg,
      max: Math.max(...bpms),
      min: Math.min(...bpms),
      normal: items.filter((item) => item.bpm >= 60 && item.bpm <= 100).length,
      high: items.filter((item) => item.bpm > 100).length,
      low: items.filter((item) => item.bpm < 60).length,
    };
  }, [history]);

  async function bootstrap() {
    const [storedConsent, storedMeasurements, storedLogs, storedLanguage] = await Promise.all([
      AsyncStorage.getItem(CONSENT_KEY),
      AsyncStorage.getItem(STORAGE_KEY),
      AsyncStorage.getItem(LOG_KEY),
      AsyncStorage.getItem(LANGUAGE_KEY),
    ]);
    setAccepted(storedConsent === 'accepted');
    if (storedLanguage === 'en' || storedLanguage === 'vi') setLanguageState(storedLanguage);
    const parsed = storedMeasurements ? JSON.parse(storedMeasurements).map(migrateMeasurement) : [];
    setMeasurements(parsed);
    measurementsRef.current = parsed;
    const parsedLogs = storedLogs ? JSON.parse(storedLogs) : [];
    setDebugLogs(parsedLogs);
    debugLogsRef.current = parsedLogs;
  }

  async function finishOnboarding() {
    await AsyncStorage.setItem(CONSENT_KEY, 'accepted');
    setAccepted(true);
  }

  async function changeLanguage(value: Language) {
    setLanguageState(value);
    await AsyncStorage.setItem(LANGUAGE_KEY, value);
  }

  async function startMeasurement() {
    setBusy(true);
    setUpdate({ ...initialUpdate, status: 'warming' });
    setFinalBpm(undefined);
    setLiveBpm(undefined);
    setPendingNoteId(undefined);
    setPendingResult(undefined);
    lastGoodUpdateRef.current = undefined;
    measurementSavedRef.current = false;
    setNoteText('');
    setActivity('Sau tập');
    setSignalHistory([]);
    try {
      const permission = await Camera.requestCameraPermissionsAsync();
      if (!permission.granted) {
        const failed = { ...initialUpdate, status: 'failed' as const, message: 'Chưa có quyền camera.' };
        setUpdate(failed);
        showDebugError('CAMERA_PERMISSION_DENIED', failed);
        Alert.alert('Chưa có quyền camera', 'Hãy cấp quyền camera trong Cài đặt để đo nhịp tim.');
        return;
      }
      const available = await HeartRatePpgModule.isAvailableAsync();
      if (!available) {
        const failed = { ...initialUpdate, status: 'failed' as const, message: 'Thiết bị cần camera sau và đèn flash.' };
        setUpdate(failed);
        showDebugError('PPG_UNAVAILABLE', failed);
        Alert.alert('Không tương thích', 'Thiết bị cần camera sau và đèn flash.');
        return;
      }
      void appendDebugLog('START_MEASUREMENT', { metric: selectedMetricRef.current });
      await HeartRatePpgModule.startMeasurementAsync(30);
    } catch (error) {
      showDebugError('START_EXCEPTION', errorToText(error));
      Alert.alert('Không bắt đầu được', error instanceof Error ? error.message : 'Có lỗi khi mở camera.');
    } finally {
      setBusy(false);
    }
  }

  async function stopMeasurement() {
    const lastGood = lastGoodUpdateRef.current;
    if (!measurementSavedRef.current && lastGood?.bpm && lastGood.elapsedMs >= 10000 && lastGood.quality >= 0.3) {
      await HeartRatePpgModule.stopMeasurementAsync();
      const completed: PpgUpdatePayload = {
        ...lastGood,
        status: 'complete',
        progress: 1,
        message: 'Đã có kết quả đo.',
      };
      setUpdate(completed);
      setFinalBpm(lastGood.bpm);
      setLiveBpm(undefined);
      completeMeasurement(completed);
      return;
    }
    void appendDebugLog('STOP_MEASUREMENT', { hasLastGood: Boolean(lastGood), saved: measurementSavedRef.current });
    await HeartRatePpgModule.stopMeasurementAsync();
  }

  async function toggleMeasurement() {
    if (busy) return;
    if (isMeasuring) {
      await stopMeasurement();
    } else {
      await startMeasurement();
    }
  }

  function completeMeasurement(event: PpgUpdatePayload) {
    if (measurementSavedRef.current || !event.bpm) return;
    measurementSavedRef.current = true;
    const metricKey = selectedMetricRef.current;
    const metric = healthMetrics.find((item) => item.key === metricKey) ?? healthMetrics[0];
    const derived = deriveHealthValues(event.bpm, event.quality, event.spo2, event.respiration);
    const metricValue = valueForMetric(metricKey, event.bpm, derived);
    const record: Measurement = {
      id: `${Date.now()}`,
      metric: metricKey,
      label: metric.label,
      value: metricValue,
      unit: metric.unit,
      bpm: event.bpm,
      ...derived,
      quality: event.quality,
      durationMs: event.elapsedMs,
      createdAt: new Date().toISOString(),
    };
    const next = [record, ...measurementsRef.current].slice(0, 100);
    setMeasurements(next);
    measurementsRef.current = next;
    setSelected(record);
    setPendingResult(record);
    setPendingNoteId(record.id);
    setNoteText('');
    setActivity('Sau tập');
    setActiveTab('measure');
    setRoute('result');
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    void appendDebugLog('RESULT_SCREEN_OPENED', {
      id: record.id,
      metric: record.metric,
      value: record.value,
      unit: record.unit,
      bpm: record.bpm,
      route: 'result',
    });
  }

  function completeEventWithFallback(event: PpgUpdatePayload): PpgUpdatePayload {
    const lastGood = lastGoodUpdateRef.current;
    if (event.bpm) return event;
    if (!lastGood?.bpm) return event;
    return {
      ...lastGood,
      ...event,
      bpm: lastGood.bpm,
      quality: event.quality || lastGood.quality,
      elapsedMs: event.elapsedMs || lastGood.elapsedMs,
      progress: 1,
      status: 'complete',
      message: event.message ?? 'complete fallback from last stable BPM',
    };
  }

  async function appendDebugLog(code: string, data?: unknown) {
    const entry: DebugEntry = { at: new Date().toISOString(), code, data };
    const next = [entry, ...debugLogsRef.current.slice(0, 199)];
    setDebugLogs(next);
    debugLogsRef.current = next;
    await AsyncStorage.setItem(LOG_KEY, JSON.stringify(next));
  }

  function showDebugError(code: string, data?: unknown) {
    void appendDebugLog(code, data);
  }

  async function shareDebugLog() {
    const content = debugLogsRef.current.map((entry) => `${entry.at} ${entry.code}\n${safeJson(entry.data)}`).join('\n\n');
    const uri = `${FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? ''}donhiptim-debug-log.txt`;
    await FileSystem.writeAsStringAsync(uri, content || 'No logs');
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri, { mimeType: 'text/plain', dialogTitle: 'Gửi log app' });
    } else {
      Alert.alert('Log app', content || 'No logs');
    }
  }

  async function saveNote() {
    if (!pendingNoteId) return;
    const cleanNote = noteText.trim();
    const next = measurementsRef.current.map((item) =>
      item.id === pendingNoteId ? { ...item, activity, note: cleanNote || undefined } : item
    );
    setMeasurements(next);
    measurementsRef.current = next;
    setSelected((item) => item?.id === pendingNoteId ? { ...item, activity, note: cleanNote || undefined } : item);
    setPendingResult((item) => item?.id === pendingNoteId ? { ...item, activity, note: cleanNote || undefined } : item);
    setPendingNoteId(undefined);
    setNoteText('');
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }

  async function finishResult() {
    await saveNote();
    setUpdate(initialUpdate);
    setFinalBpm(undefined);
    setSignalHistory([]);
    setPendingResult(undefined);
    setRoute('main');
    setActiveTab('history');
  }

  async function measureAgainFromResult() {
    await saveNote();
    setPendingResult(undefined);
    setRoute('main');
    setActiveTab('measure');
    await startMeasurement();
  }

  async function skipNote() {
    await finishResult();
  }

  function closeResult() {
    setNoteText('');
    setPendingNoteId(undefined);
    setPendingResult(undefined);
    setUpdate(initialUpdate);
    setFinalBpm(undefined);
    setRoute('main');
  }

  function openDetail(item: Measurement) {
    setSelected(item);
    setRoute('detail');
  }

  function goTab(tab: TabKey) {
    setActiveTab(tab);
    setRoute('main');
  }

  if (!accepted) {
    return (
      <SafeAreaView style={styles.lightSafe}>
        <StatusBar style="dark" />
        <Onboarding page={onboardPage} setPage={setOnboardPage} finish={finishOnboarding} language={language} />
      </SafeAreaView>
    );
  }

  if (pendingResult) {
    return (
      <SafeAreaView style={styles.lightSafe}>
        <StatusBar style="dark" />
        <ResultScreen
          item={pendingResult}
          language={language}
          values={signalHistory}
          noteText={noteText}
          setNoteText={setNoteText}
          activity={activity}
          setActivity={setActivity}
          back={closeResult}
          finish={() => void finishResult()}
          measureAgain={() => void measureAgainFromResult()}
        />
      </SafeAreaView>
    );
  }

  if (route !== 'main') {
    return (
      <SafeAreaView style={styles.lightSafe}>
        <StatusBar style="dark" />
        <RouteScreen
          route={route}
          language={language}
          selected={selected}
          history={history}
          reminderOn={reminderOn}
          setReminderOn={setReminderOn}
          pendingResult={pendingResult}
          values={signalHistory}
          noteText={noteText}
          setNoteText={setNoteText}
          activity={activity}
          setActivity={setActivity}
          finishResult={() => void finishResult()}
          measureAgain={() => void measureAgainFromResult()}
          back={() => setRoute('main')}
          start={() => {
            setRoute('main');
            setActiveTab('measure');
            void startMeasurement();
          }}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={activeTab === 'measure' ? styles.darkSafe : styles.lightSafe}>
      <StatusBar style={activeTab === 'measure' ? 'light' : 'dark'} />
      {activeTab === 'measure' ? (
        <MeasureScreen
          update={update}
          language={language}
          latest={latest}
          visibleBpm={visibleBpm}
          progress={progressValue}
          values={signalHistory}
          busy={busy}
          isMeasuring={isMeasuring}
          toggleMeasurement={toggleMeasurement}
          openGuide={() => setRoute('guide')}
          openFinger={() => setRoute('finger')}
          openHistory={() => goTab('history')}
          selectedMetric={selectedMetric}
          setSelectedMetric={setSelectedMetric}
        />
      ) : activeTab === 'history' ? (
        <HistoryScreen items={history} realCount={measurements.length} openDetail={openDetail} openEmpty={() => setRoute('empty-history')} language={language} />
      ) : activeTab === 'stats' ? (
        <StatsScreen items={history} stats={stats} language={language} />
      ) : (
        <SettingsScreen
          reminderOn={reminderOn}
          setReminderOn={setReminderOn}
          themeLight={themeLight}
          setThemeLight={setThemeLight}
          language={language}
          setLanguage={(value) => void changeLanguage(value)}
          openGuide={() => setRoute('guide')}
          openReminder={() => setRoute('reminder')}
          openExport={() => setRoute('export')}
          resetOnboarding={() => {
            setOnboardPage(0);
            setAccepted(false);
          }}
        />
      )}
      <BottomTabs active={activeTab} goTab={goTab} language={language} />
    </SafeAreaView>
  );
}

function Onboarding({ page, setPage, finish, language }: { page: number; setPage: (page: number) => void; finish: () => void; language: Language }) {
  const pages = [
    {
      title: tx(language, 'onboardHeartTitle'),
      text: tx(language, 'onboardHeartText'),
      art: <HeartArt />,
    },
    {
      title: tx(language, 'onboardPrivacyTitle'),
      text: tx(language, 'onboardPrivacyText'),
      art: <ShieldArt />,
    },
    {
      title: tx(language, 'onboardTrackTitle'),
      text: tx(language, 'onboardTrackText'),
      art: <ChartCardArt />,
    },
    {
      title: tx(language, 'onboardStartTitle'),
      text: tx(language, 'onboardStartText'),
      art: <FingerPhoneArt />,
    },
  ];
  const item = pages[page];

  return (
    <View style={styles.onboardWrap}>
      <View style={styles.onboardArt}>{item.art}</View>
      <Text style={styles.onboardTitle}>{item.title}</Text>
      <Text style={styles.onboardText}>{item.text}</Text>
      <Pressable style={styles.primaryButton} onPress={page === pages.length - 1 ? finish : () => setPage(page + 1)}>
        <Text style={styles.primaryButtonText}>{page === pages.length - 1 ? tx(language, 'startNow') : tx(language, 'continue')}</Text>
      </Pressable>
      {page === pages.length - 1 ? (
        <Pressable onPress={finish}>
          <Text style={styles.skipText}>{tx(language, 'later')}</Text>
        </Pressable>
      ) : null}
      <View style={styles.dots}>
        {pages.map((_, index) => (
          <View key={index} style={[styles.dot, index === page && styles.dotActive]} />
        ))}
      </View>
    </View>
  );
}

function MeasureScreen({
  update,
  language,
  latest,
  visibleBpm,
  progress,
  values,
  busy,
  isMeasuring,
  toggleMeasurement,
  openGuide,
  openFinger,
  openHistory,
  selectedMetric,
  setSelectedMetric,
}: {
  update: PpgUpdatePayload;
  language: Language;
  latest?: Measurement;
  visibleBpm?: number;
  progress: number;
  values: number[];
  busy: boolean;
  isMeasuring: boolean;
  toggleMeasurement: () => void;
  openGuide: () => void;
  openFinger: () => void;
  openHistory: () => void;
  selectedMetric: MetricKey;
  setSelectedMetric: (value: MetricKey) => void;
}) {
  const complete = update.status === 'complete';
  const failed = update.status === 'failed';
  const metric = healthMetrics.find((item) => item.key === selectedMetric) ?? healthMetrics[0];
  const liveMetricValue = visibleBpm ? displayValueForMetricFromBpm(selectedMetric, visibleBpm, update.quality) : undefined;
  const measureValueText = failed ? '--' : liveMetricValue ? String(liveMetricValue).padStart(selectedMetric === 'heartRate' ? 2 : 0, '0') : isMeasuring ? '--' : '00';
  const measureUnitText = failed ? tx(language, 'retryUpper') : isMeasuring && !liveMetricValue ? `${Math.max(0, 30 - Math.floor(update.elapsedMs / 1000))} ${tx(language, 'seconds')}` : displayUnitForMetric(selectedMetric, language);
  const heartScale = useRef(new Animated.Value(1)).current;
  const metricName = metricNameFor(selectedMetric, language);
  const label = failed ? tx(language, 'badSignal') : complete ? tx(language, 'result') : isMeasuring ? `${tx(language, 'measuring')} ${metricName.toLowerCase()}` : tx(language, 'hello');
  const sub = failed ? tx(language, 'coverCamera') : complete ? statusByBpm(visibleBpm, language) : isMeasuring ? tx(language, 'holdStill') : tx(language, 'tapStart');

  useEffect(() => {
    if (!isMeasuring || !visibleBpm) return;
    Animated.sequence([
      Animated.timing(heartScale, { toValue: 1.28, duration: 110, useNativeDriver: true }),
      Animated.timing(heartScale, { toValue: 1, duration: 180, useNativeDriver: true }),
    ]).start();
  }, [heartScale, isMeasuring, visibleBpm]);

  return (
    <View style={styles.measurePage}>
      <View style={styles.darkHeader}>
        <View>
          <Text style={styles.brand}>{tx(language, 'appTitle')}</Text>
          <Text style={styles.brandSub}>{tx(language, 'appSub')}</Text>
        </View>
        <Pressable style={styles.roundIcon} onPress={openGuide}>
          <Text style={styles.roundIconText}>?</Text>
        </Pressable>
      </View>

      <View style={styles.measureTabs}>
        <Pressable onPress={openGuide}><Text style={styles.measureTab}>{tx(language, 'helpUpper')}</Text></Pressable>
        <Text style={[styles.measureTab, styles.measureTabActive]}>{tx(language, 'measureUpper')}</Text>
        <Pressable onPress={openHistory}><Text style={styles.measureTab}>{tx(language, 'historyUpper')}</Text></Pressable>
      </View>

      <View style={styles.measureBody}>
        {!isMeasuring && !failed && !complete ? (
          <View style={styles.metricPickerPanel}>
            <Text style={styles.metricPickerTitle}>{tx(language, 'chooseMetric')}</Text>
            {healthMetrics.map((item) => (
              <Pressable
                key={item.key}
                style={[styles.metricPickRow, selectedMetric === item.key && styles.metricPickRowActive]}
                onPress={() => setSelectedMetric(item.key)}
              >
                <View style={[styles.metricPickIcon, { backgroundColor: `${item.color}22` }]}>
                  <Text style={[styles.metricPickIconText, { color: item.color }]}>{item.icon}</Text>
                </View>
                <View style={styles.metricPickContent}>
                  <Text style={styles.metricPickTitle}>{metricNameFor(item.key, language)}</Text>
                  <Text style={styles.metricPickDescription}>{metricDescriptionFor(item.key, language)}</Text>
                </View>
                <Text style={styles.chevron}>›</Text>
              </Pressable>
            ))}
            <Pressable style={styles.primaryButton} onPress={toggleMeasurement}>
              <Text style={styles.primaryButtonText}>{tx(language, 'startMeasure')} {metricName.toLowerCase()}</Text>
            </Pressable>
            {selectedMetric === 'spo2' ? <Text style={styles.spo2Disclaimer}>Estimated SpO2 - For wellness purposes only.</Text> : null}
          </View>
        ) : (
          <>
        <Text style={styles.measureTitle}>{label}</Text>
        <Pressable disabled={busy} onPress={toggleMeasurement} style={styles.dialButton}>
          <ProgressDial progress={complete ? 1 : progress} failed={failed} />
          {failed ? (
            <Text style={styles.faceIcon}>:(</Text>
          ) : complete ? (
            <HeartShape small />
          ) : (
            <Animated.Text style={[styles.measureHeart, { transform: [{ scale: heartScale }] }]}>♥</Animated.Text>
          )}
          <Text style={styles.measureBpm}>{measureValueText}</Text>
          <Text style={styles.measureUnit}>{measureUnitText}</Text>
        </Pressable>
        <Text style={styles.measureHint}>{selectedMetric === 'spo2' ? 'Estimated SpO2 - For wellness purposes only.' : selectedMetric === 'respiration' ? 'Estimated Respiratory Rate - Wellness Purpose Only' : sub}</Text>
        <Waveform values={values} active={isMeasuring} dark />
        <View style={styles.measureActions}>
          <Pressable style={styles.darkGhostButton} onPress={openFinger}>
            <Text style={styles.darkGhostText}>{tx(language, 'fingerPosition')}</Text>
          </Pressable>
          <Pressable style={styles.primaryButtonSmall} onPress={toggleMeasurement}>
            <Text style={styles.primaryButtonText}>{isMeasuring ? tx(language, 'stop') : failed ? tx(language, 'retry') : tx(language, 'startMeasure')}</Text>
          </Pressable>
        </View>
        <Text style={styles.previousDark}>{tx(language, 'historyHint')}</Text>
          </>
        )}
      </View>
    </View>
  );
}

function HistoryScreen({
  items,
  realCount,
  openDetail,
  openEmpty,
  language,
}: {
  items: Measurement[];
  realCount: number;
  openDetail: (item: Measurement) => void;
  openEmpty: () => void;
  language: Language;
}) {
  const [period, setPeriod] = useState<HistoryPeriod>('day');
  const groups = groupHistory(items, period, language);

  return (
    <ScreenScaffold title={tx(language, 'historyTitle')}>
      <Segmented
        labels={[tx(language, 'day'), tx(language, 'week'), tx(language, 'month')]}
        active={period === 'day' ? 0 : period === 'week' ? 1 : 2}
        onChange={(index) => setPeriod(index === 0 ? 'day' : index === 1 ? 'week' : 'month')}
      />
      {realCount === 0 ? (
        <Pressable style={styles.emptyHint} onPress={openEmpty}>
          <ClipboardArt />
          <Text style={styles.emptyTitle}>{tx(language, 'emptyHistory')}</Text>
          <Text style={styles.emptyText}>{tx(language, 'demoHistoryHint')}</Text>
        </Pressable>
      ) : null}
      {groups.map((group) => (
        <View key={group.title}>
          <Text style={styles.sectionLabel}>{group.title}</Text>
          {group.items.map((item) => <HistoryRow key={item.id} item={item} openDetail={openDetail} language={language} />)}
        </View>
      ))}
    </ScreenScaffold>
  );
}

function HistoryRow({ item, openDetail, language }: { item: Measurement; openDetail: (item: Measurement) => void; language: Language }) {
  return (
    <Pressable style={styles.historyRow} onPress={() => openDetail(item)}>
      <Text style={styles.historyTime}>{timeOnly(item.createdAt)}</Text>
      <Text style={styles.historyHeart}>♥</Text>
      <View style={styles.historyMain}>
        <Text style={styles.historyBpm}>{metricNameFor(item.metric, language)}: {formatMetricValue(item, language)}</Text>
        {item.activity || item.note ? <Text style={styles.historyNote} numberOfLines={1}>{[item.activity, item.note].filter(Boolean).join(' - ')}</Text> : null}
      </View>
      <Text style={[styles.historyStatus, metricIsHigh(item) && styles.historyStatusHigh]}>{statusForMeasurement(item, language)}</Text>
    </Pressable>
  );
}

function StatsScreen({ items, stats, language }: { items: Measurement[]; stats: { avg: number; max: number; min: number; normal: number; high: number; low: number }; language: Language }) {
  return (
    <ScreenScaffold title={tx(language, 'stats')}>
      <Segmented labels={[tx(language, 'day'), tx(language, 'week'), tx(language, 'month')]} active={1} />
      <View style={styles.summaryGrid}>
        <Metric label={tx(language, 'average')} value={`${stats.avg}`} suffix="BPM" />
        <Metric label={tx(language, 'highest')} value={`${stats.max}`} suffix="BPM" accent />
        <Metric label={tx(language, 'lowest')} value={`${stats.min}`} suffix="BPM" />
      </View>
      <ChartLine items={items} />
      <Text style={styles.sectionLabel}>{tx(language, 'heartZones')}</Text>
      <View style={styles.card}>
        <Donut low={stats.low} normal={stats.normal} high={stats.high} />
        <View style={styles.legend}>
          <Legend color="#2f80ed" label={tx(language, 'lowZone')} value={`${stats.low}`} />
          <Legend color="#22c55e" label={tx(language, 'normalZone')} value={`${stats.normal}`} />
          <Legend color={rose} label={tx(language, 'highZone')} value={`${stats.high}`} />
        </View>
      </View>
      <Text style={styles.sectionLabel}>Phân bố nhịp tim</Text>
      <Bars values={[stats.low + 1, stats.normal + 2, stats.high + 1, 2]} />
    </ScreenScaffold>
  );
}

function SettingsScreen({
  reminderOn,
  setReminderOn,
  themeLight,
  setThemeLight,
  language,
  setLanguage,
  openGuide,
  openReminder,
  openExport,
  resetOnboarding,
}: {
  reminderOn: boolean;
  setReminderOn: (value: boolean) => void;
  themeLight: boolean;
  setThemeLight: (value: boolean) => void;
  language: Language;
  setLanguage: (value: Language) => void;
  openGuide: () => void;
  openReminder: () => void;
  openExport: () => void;
  resetOnboarding: () => void;
}) {
  return (
    <ScreenScaffold title={tx(language, 'settings')}>
      <SettingsRow icon="♡" title={tx(language, 'heartUnit')} value="BPM" />
      <SettingsRow icon="◴" title={tx(language, 'reminder')} value={reminderOn ? tx(language, 'on') : tx(language, 'off')} onPress={openReminder} />
      <SettingsRow icon="⏰" title={tx(language, 'reminderTime')} value="09:00" />
      <View style={styles.settingSwitchRow}>
        <View style={styles.settingLeft}><Text style={styles.settingIcon}>☼</Text><Text style={styles.settingTitle}>{tx(language, 'lightTheme')}</Text></View>
        <Switch value={themeLight} onValueChange={setThemeLight} trackColor={{ true: '#f8b6c4' }} thumbColor={themeLight ? rose : '#ffffff'} />
      </View>
      <SettingsRow icon="🌐" title={tx(language, 'language')} value={language === 'vi' ? 'Tiếng Việt' : 'English'} onPress={() => setLanguage(language === 'vi' ? 'en' : 'vi')} />
      <SettingsRow icon="?" title={tx(language, 'guide')} onPress={openGuide} />
      <SettingsRow icon="⇪" title={tx(language, 'exportData')} onPress={openExport} />
      <SettingsRow icon="▣" title={tx(language, 'privacy')} value={tx(language, 'localOnly')} />
      <SettingsRow icon="i" title={tx(language, 'about')} value={tx(language, 'version')} />
      <Pressable style={styles.secondaryButton} onPress={resetOnboarding}>
        <Text style={styles.secondaryText}>{tx(language, 'replayOnboarding')}</Text>
      </Pressable>
    </ScreenScaffold>
  );
}

function RouteScreen({
  route,
  language,
  selected,
  history,
  reminderOn,
  setReminderOn,
  pendingResult,
  values,
  noteText,
  setNoteText,
  activity,
  setActivity,
  finishResult,
  measureAgain,
  back,
  start,
}: {
  route: RouteKey;
  language: Language;
  selected?: Measurement;
  history: Measurement[];
  reminderOn: boolean;
  setReminderOn: (value: boolean) => void;
  pendingResult?: Measurement;
  values: number[];
  noteText: string;
  setNoteText: (value: string) => void;
  activity: string;
  setActivity: (value: string) => void;
  finishResult: () => void;
  measureAgain: () => void;
  back: () => void;
  start: () => void;
}) {
  if (route === 'guide') {
    return (
      <ScreenScaffold title={tx(language, 'guideTitle')} back={back}>
        <GuideStep number="1" title={tx(language, 'guide1Title')} text={tx(language, 'guide1Text')} />
        <GuideStep number="2" title={tx(language, 'guide2Title')} text={tx(language, 'guide2Text')} />
        <GuideStep number="3" title={tx(language, 'guide3Title')} text={tx(language, 'guide3Text')} />
        <Pressable style={styles.primaryButton} onPress={start}>
          <Text style={styles.primaryButtonText}>{tx(language, 'gotItStart')}</Text>
        </Pressable>
      </ScreenScaffold>
    );
  }

  if (route === 'finger') {
    return (
      <ScreenScaffold title={tx(language, 'fingerPosition')} back={back}>
        <FingerPhoneArt large />
        <Text style={styles.bigInstruction}>{tx(language, 'fingerInstruction')}</Text>
        <Text style={styles.centerMuted}>{tx(language, 'fingerHint')}</Text>
        <Pressable style={styles.primaryButton} onPress={start}>
          <Text style={styles.primaryButtonText}>{tx(language, 'startMeasure')}</Text>
        </Pressable>
      </ScreenScaffold>
    );
  }

  if (route === 'result') {
    const item = pendingResult ?? selected ?? history[0];
    return (
      <ResultScreen
        item={item}
        language={language}
        values={values}
        noteText={noteText}
        setNoteText={setNoteText}
        activity={activity}
        setActivity={setActivity}
        back={back}
        finish={finishResult}
        measureAgain={measureAgain}
      />
    );
  }

  if (route === 'detail') {
    const item = selected ?? history[0];
    return (
      <ScreenScaffold title={tx(language, 'detailTitle')} back={back}>
        <Text style={styles.detailDate}>{dateOnly(item.createdAt)} - {timeOnly(item.createdAt)}</Text>
        <HeartResult item={item} />
        <RangeScale bpm={item.bpm} />
        <View style={styles.noticeBox}>
          <Text style={styles.noticeText}>{metricNameFor(item.metric, language)}: {statusForMeasurement(item, language)}.</Text>
        </View>
        {item.note ? (
          <View style={styles.noticeBox}>
            <Text style={styles.noteDetailLabel}>{tx(language, 'note')}</Text>
            <Text style={styles.noticeText}>{item.note}</Text>
          </View>
        ) : null}
        {item.activity ? (
          <View style={styles.noticeBox}>
            <Text style={styles.noteDetailLabel}>{tx(language, 'activity')}</Text>
            <Text style={styles.noticeText}>{item.activity}</Text>
          </View>
        ) : null}
        <View style={styles.summaryGrid}>
          <Metric label={tx(language, 'duration')} value={`${Math.round(item.durationMs / 1000)}`} suffix={tx(language, 'seconds')} />
          <Metric label={tx(language, 'confidence')} value={`${Math.round(item.quality * 100)}`} suffix="%" />
        </View>
      </ScreenScaffold>
    );
  }

  if (route === 'reminder') {
    return (
      <ScreenScaffold title={tx(language, 'reminderTitle')} back={back}>
        <BellArt />
        <Text style={styles.bigInstruction}>{tx(language, 'reminderBig')}</Text>
        <Text style={styles.centerMuted}>{tx(language, 'reminderSub')}</Text>
        <View style={styles.settingSwitchRow}>
          <View style={styles.settingLeft}><Text style={styles.settingIcon}>◴</Text><Text style={styles.settingTitle}>{tx(language, 'dailyReminder')}</Text></View>
          <Switch value={reminderOn} onValueChange={setReminderOn} trackColor={{ true: '#f8b6c4' }} thumbColor={reminderOn ? rose : '#ffffff'} />
        </View>
        <Pressable style={styles.primaryButton} onPress={start}>
          <Text style={styles.primaryButtonText}>{tx(language, 'measureNow')}</Text>
        </Pressable>
      </ScreenScaffold>
    );
  }

  if (route === 'export') {
    return (
      <ScreenScaffold title={tx(language, 'exportData')} back={back}>
        <SettingsRow icon="□" title={tx(language, 'exportPdf')} onPress={() => Alert.alert(tx(language, 'exportData'), tx(language, 'exportReady'))} />
        <SettingsRow icon="▤" title={tx(language, 'exportExcel')} onPress={() => Alert.alert(tx(language, 'exportData'), tx(language, 'exportReady'))} />
        <SettingsRow icon="≡" title={tx(language, 'exportCsv')} onPress={() => Alert.alert(tx(language, 'exportData'), tx(language, 'exportReady'))} />
      </ScreenScaffold>
    );
  }

  return (
    <ScreenScaffold title={tx(language, 'emptyHistory')} back={back}>
      <ClipboardArt />
      <Text style={styles.bigInstruction}>{tx(language, 'noHistory')}</Text>
      <Text style={styles.centerMuted}>{tx(language, 'startFirst')}</Text>
      <Pressable style={styles.primaryButton} onPress={start}>
        <Text style={styles.primaryButtonText}>{tx(language, 'startMeasure')}</Text>
      </Pressable>
    </ScreenScaffold>
  );
}

function ResultScreen({
  item,
  language,
  values,
  noteText,
  setNoteText,
  activity,
  setActivity,
  back,
  finish,
  measureAgain,
}: {
  item: Measurement;
  language: Language;
  values: number[];
  noteText: string;
  setNoteText: (value: string) => void;
  activity: string;
  setActivity: (value: string) => void;
  back: () => void;
  finish: () => void;
  measureAgain: () => void;
}) {
  const options = [
    { label: tx(language, 'resting'), value: 'Nghỉ ngơi', icon: '♙' },
    { label: tx(language, 'afterWorkout'), value: 'Sau tập', icon: '♢' },
    { label: tx(language, 'sitting'), value: 'Đang ngồi', icon: '♘' },
    { label: tx(language, 'active'), value: 'Vận động', icon: '↗' },
  ];
  const activityLabel = options.find((option) => option.value === activity)?.label ?? activity;

  return (
    <View style={styles.resultPage}>
      <View style={styles.resultHeader}>
        <Pressable onPress={back}><Text style={styles.resultBack}>‹</Text></Pressable>
        <Text style={styles.resultHeaderTitle}>{tx(language, 'yourResult')} {metricNameFor(item.metric, language).toLowerCase()}</Text>
        <Text style={styles.resultMenu}>•••</Text>
      </View>
      <ScrollView contentContainerStyle={styles.resultContent} showsVerticalScrollIndicator={false}>
        <Text style={styles.resultTopBpm}>{formatMetricValue(item, language)}</Text>
        <Text style={styles.resultTopDate}>{formatDate(item.createdAt)}</Text>
        <RangeScale bpm={item.bpm} />
        <Text style={styles.resultSummary}>{metricNameFor(item.metric, language)} / {tx(language, 'status')}: {statusForMeasurement(item, language)}</Text>
        {item.metric === 'spo2' ? <Text style={styles.resultDisclaimer}>Estimated SpO2 - For wellness purposes only.</Text> : null}
        {item.metric === 'respiration' ? <Text style={styles.resultDisclaimer}>Estimated Respiratory Rate - Wellness Purpose Only</Text> : null}
        <Text style={styles.resultQuality}>♡ {tx(language, 'confidence')}: {Math.round(item.quality * 100)}%</Text>

        <View style={styles.activityRow}>
          {options.map((option) => (
            <ActivityOption
              key={option.value}
              label={option.label}
              icon={option.icon}
              active={activity === option.value}
              onPress={() => setActivity(option.value)}
            />
          ))}
        </View>
        <Text style={styles.activityLabel}>{activityLabel}</Text>

        <TextInput
          style={styles.resultNoteInput}
          value={noteText}
          onChangeText={setNoteText}
          placeholder={tx(language, 'notePlaceholder')}
          placeholderTextColor="#8b949e"
          maxLength={180}
          multiline
        />

        <View style={styles.resultWaveBox}>
          <Waveform values={values} active dark={false} width={screenWidth - 72} />
        </View>

        <View style={styles.resultActionRow}>
          <Pressable style={styles.resultSecondaryButton} onPress={measureAgain}>
            <Text style={styles.resultSecondaryText}>{tx(language, 'measureAgain')}</Text>
          </Pressable>
          <Pressable style={styles.resultPrimaryButton} onPress={finish}>
            <Text style={styles.resultPrimaryText}>{tx(language, 'continue')}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

function ActivityOption({ label, icon, active, onPress }: { label: string; icon: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable style={styles.activityOption} onPress={onPress}>
      <View style={[styles.activityCircle, active && styles.activityCircleActive]}>
        <Text style={[styles.activityIcon, active && styles.activityIconActive]}>{icon}</Text>
        {active ? <Text style={styles.activityCheck}>✓</Text> : null}
      </View>
      <Text style={styles.activityText}>{label}</Text>
    </Pressable>
  );
}

function ScreenScaffold({ title, back, children }: { title: string; back?: () => void; children: React.ReactNode }) {
  return (
    <View style={styles.lightPage}>
      <View style={styles.lightHeader}>
        {back ? <Pressable onPress={back}><Text style={styles.backText}>‹</Text></Pressable> : <View style={styles.headerSlot} />}
        <Text style={styles.lightTitle}>{title}</Text>
        <View style={styles.headerSlot} />
      </View>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {children}
      </ScrollView>
    </View>
  );
}

function BottomTabs({ active, goTab, language }: { active: TabKey; goTab: (tab: TabKey) => void; language: Language }) {
  const tabs: { key: TabKey; label: string; icon: string }[] = [
    { key: 'measure', label: tx(language, 'home'), icon: '⌂' },
    { key: 'history', label: tx(language, 'history'), icon: '◷' },
    { key: 'stats', label: tx(language, 'stats'), icon: '▥' },
    { key: 'settings', label: tx(language, 'settings'), icon: '⚙' },
  ];
  return (
    <View style={styles.bottomTabs}>
      {tabs.map((tab) => (
        <Pressable key={tab.key} style={styles.bottomTab} onPress={() => goTab(tab.key)}>
          <Text style={[styles.bottomIcon, active === tab.key && styles.bottomActive]}>{tab.icon}</Text>
          <Text style={[styles.bottomLabel, active === tab.key && styles.bottomActive]}>{tab.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function ProgressDial({ progress, failed }: { progress: number; failed: boolean }) {
  const stroke = 18;
  const radius = (dialSize - stroke) / 2;
  const center = dialSize / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <Svg width={dialSize} height={dialSize} style={styles.absoluteSvg}>
      <Circle cx={center} cy={center} r={radius} stroke={failed ? '#8c3044' : '#34233b'} strokeWidth={stroke} fill="transparent" />
      <Circle
        cx={center}
        cy={center}
        r={radius}
        stroke={failed ? '#ff627f' : rose}
        strokeWidth={stroke}
        fill="transparent"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={circumference * (1 - Math.max(0.02, progress))}
        strokeLinecap="round"
        transform={`rotate(-90 ${center} ${center})`}
      />
    </Svg>
  );
}

function Waveform({ values, active, dark, width = screenWidth - 28 }: { values: number[]; active: boolean; dark?: boolean; width?: number }) {
  const height = 86;
  const points = values.length >= 4 ? values : [118, 124, 112, 138, 98, 126, 116, 154, 104, 126, 119, 146, 109, 128];
  const minValue = Math.min(...points);
  const maxValue = Math.max(...points);
  const svgPoints = points
    .map((value, index) => {
      const x = (index / Math.max(points.length - 1, 1)) * width;
      const y = height - 16 - normalize(value, minValue, maxValue) * 54;
      return `${x},${y}`;
    })
    .join(' ');
  return (
    <Svg width={width} height={height} style={styles.waveSvg}>
      {!dark ? (
        <>
          {[0, 1, 2, 3, 4].map((row) => <Line key={`r-${row}`} x1="0" x2={width} y1={10 + row * 16} y2={10 + row * 16} stroke="#d5d9de" strokeWidth="1" />)}
          {Array.from({ length: 18 }).map((_, col) => <Line key={`c-${col}`} x1={col * (width / 17)} x2={col * (width / 17)} y1="0" y2={height} stroke="#d5d9de" strokeWidth="1" />)}
        </>
      ) : null}
      <Polyline points={svgPoints} fill="none" stroke={dark ? (active ? rose : '#ffffff') : rose} strokeWidth={2} opacity={active ? 1 : 0.55} />
    </Svg>
  );
}

function ChartLine({ items }: { items: Measurement[] }) {
  const width = screenWidth - 64;
  const height = 150;
  const values = [...items].slice(0, 7).reverse().map((item) => item.bpm);
  const minValue = Math.min(...values, 55);
  const maxValue = Math.max(...values, 110);
  const points = values
    .map((value, index) => {
      const x = 18 + (index / Math.max(values.length - 1, 1)) * (width - 36);
      const y = 18 + (1 - normalize(value, minValue, maxValue)) * (height - 44);
      return `${x},${y}`;
    })
    .join(' ');
  return (
    <View style={styles.card}>
      <Svg width={width} height={height}>
        {[0, 1, 2, 3].map((row) => <Line key={row} x1="12" x2={width - 12} y1={24 + row * 30} y2={24 + row * 30} stroke="#edf1f5" strokeWidth="1" />)}
        <Polyline points={points} fill="none" stroke={rose} strokeWidth="3" />
        {values.map((value, index) => {
          const x = 18 + (index / Math.max(values.length - 1, 1)) * (width - 36);
          const y = 18 + (1 - normalize(value, minValue, maxValue)) * (height - 44);
          return <Circle key={`${value}-${index}`} cx={x} cy={y} r="4" fill="#ffffff" stroke={rose} strokeWidth="2" />;
        })}
      </Svg>
    </View>
  );
}

function Bars({ values }: { values: number[] }) {
  const width = screenWidth - 64;
  const height = 160;
  const colors = ['#60a5fa', '#4ade80', '#fb923c', rose];
  return (
    <View style={styles.card}>
      <Svg width={width} height={height}>
        {values.map((value, index) => {
          const barHeight = Math.max(24, value * 24);
          const x = 36 + index * ((width - 72) / values.length);
          return <Rect key={index} x={x} y={height - barHeight - 24} width={34} height={barHeight} rx={5} fill={colors[index]} />;
        })}
      </Svg>
    </View>
  );
}

function Donut({ low, normal, high }: { low: number; normal: number; high: number }) {
  const total = Math.max(low + normal + high, 1);
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const normalDash = (normal / total) * circumference;
  const highDash = (high / total) * circumference;
  return (
    <Svg width={104} height={104}>
      <Circle cx="52" cy="52" r={radius} stroke="#2f80ed" strokeWidth="16" fill="transparent" />
      <Circle cx="52" cy="52" r={radius} stroke="#22c55e" strokeWidth="16" fill="transparent" strokeDasharray={`${normalDash} ${circumference}`} transform="rotate(-90 52 52)" />
      <Circle cx="52" cy="52" r={radius} stroke={rose} strokeWidth="16" fill="transparent" strokeDasharray={`${highDash} ${circumference}`} transform="rotate(90 52 52)" />
    </Svg>
  );
}

function Metric({ label, value, suffix, accent }: { label: string; value: string; suffix: string; accent?: boolean }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, accent && styles.metricAccent]}>{value} <Text style={styles.metricSuffix}>{suffix}</Text></Text>
    </View>
  );
}

function SettingsRow({ icon, title, value, onPress }: { icon: string; title: string; value?: string; onPress?: () => void }) {
  return (
    <Pressable style={styles.settingRow} onPress={onPress}>
      <View style={styles.settingLeft}><Text style={styles.settingIcon}>{icon}</Text><Text style={styles.settingTitle}>{title}</Text></View>
      <View style={styles.settingRight}><Text style={styles.settingValue}>{value}</Text><Text style={styles.chevron}>›</Text></View>
    </Pressable>
  );
}

function GuideStep({ number, title, text }: { number: string; title: string; text: string }) {
  return (
    <View style={styles.guideStep}>
      <Text style={styles.stepNumber}>{number}</Text>
      <View style={{ flex: 1 }}>
        <Text style={styles.stepTitle}>{title}</Text>
        <Text style={styles.stepText}>{text}</Text>
      </View>
    </View>
  );
}

function Segmented({ labels, active, onChange }: { labels: string[]; active: number; onChange?: (index: number) => void }) {
  return (
    <View style={styles.segmented}>
      {labels.map((label, index) => (
        <Pressable key={label} style={[styles.segment, active === index && styles.segmentActive]} onPress={() => onChange?.(index)}>
          <Text style={[styles.segmentText, active === index && styles.segmentTextActive]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function RangeScale({ bpm }: { bpm: number }) {
  return (
    <View style={styles.rangeWrap}>
      <View style={styles.rangeLine}>
        <View style={[styles.rangePart, { backgroundColor: '#60a5fa' }]} />
        <View style={[styles.rangePart, { backgroundColor: '#22c55e' }]} />
        <View style={[styles.rangePart, { backgroundColor: rose }]} />
      </View>
      <View style={[styles.rangeMarker, { left: `${Math.max(4, Math.min(92, ((bpm - 45) / 80) * 100))}%` }]} />
      <View style={styles.rangeLabels}>
        <Text style={styles.rangeLabel}>Thấp{'\n'}&lt;60</Text>
        <Text style={styles.rangeLabel}>Bình thường{'\n'}60 - 100</Text>
        <Text style={styles.rangeLabel}>Cao{'\n'}&gt;100</Text>
      </View>
    </View>
  );
}

function Legend({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <View style={styles.legendRow}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendLabel}>{label}</Text>
      <Text style={styles.legendValue}>{value}</Text>
    </View>
  );
}

function HeartResult({ item }: { item: Measurement }) {
  return (
    <View style={styles.resultWrap}>
      <HeartShape />
      <Text style={styles.resultBpm}>{formatMetricValue(item).split(' ')[0]}</Text>
      <Text style={styles.resultUnit}>{item.unit || item.label}</Text>
      <Text style={styles.resultStatus}>{statusForMeasurement(item)} ●</Text>
    </View>
  );
}

function HeartShape({ small }: { small?: boolean }) {
  const size = small ? 96 : 190;
  return (
    <Svg width={size} height={size * 0.86} style={small ? undefined : styles.heartResultSvg} viewBox="0 0 120 104">
      <Path d="M60 96 C 24 72 8 52 8 30 C 8 14 20 4 36 4 C 47 4 55 11 60 20 C 65 11 73 4 84 4 C 100 4 112 14 112 30 C 112 52 96 72 60 96 Z" fill={small ? '#30172a' : '#fff3f6'} stroke={rose} strokeWidth="4" />
    </Svg>
  );
}

function HeartArt() {
  return (
    <Svg width={170} height={150} viewBox="0 0 170 150">
      <Path d="M85 130 C 34 96 18 70 18 42 C 18 20 34 8 54 8 C 69 8 79 18 85 30 C 91 18 101 8 116 8 C 136 8 152 20 152 42 C 152 70 136 96 85 130 Z" fill={rose} />
      <Polyline points="20,77 54,77 65,60 78,94 93,45 106,77 150,77" fill="none" stroke="#fff" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function ShieldArt() {
  return (
    <Svg width={160} height={150} viewBox="0 0 160 150">
      <Path d="M80 12 L128 30 V68 C128 100 108 124 80 138 C52 124 32 100 32 68 V30 Z" fill="#ffedf2" stroke={rose} strokeWidth="6" />
      <Path d="M54 72 L72 90 L110 50" fill="none" stroke={rose} strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function ChartCardArt() {
  return (
    <Svg width={180} height={130} viewBox="0 0 180 130">
      <Rect x="18" y="20" width="144" height="90" rx="12" fill="#ffffff" stroke="#e5e7eb" />
      {[0, 1, 2, 3].map((i) => <Rect key={i} x={46 + i * 18} y={72 - i * 10} width="9" height={30 + i * 10} rx="4" fill={rose} opacity={0.75 + i * 0.06} />)}
      <Rect x="108" y="46" width="35" height="6" rx="3" fill="#d9dee7" />
      <Rect x="108" y="64" width="24" height="6" rx="3" fill="#d9dee7" />
      <Circle cx="136" cy="36" r="12" fill="#4ade80" />
      <Path d="M130 36 L135 41 L143 31" stroke="#fff" strokeWidth="4" fill="none" strokeLinecap="round" />
    </Svg>
  );
}

function FingerPhoneArt({ large }: { large?: boolean }) {
  const width = large ? 250 : 190;
  return (
    <Svg width={width} height={large ? 300 : 230} viewBox="0 0 190 230">
      <Rect x="38" y="18" width="114" height="190" rx="24" fill="#1f2937" />
      <Circle cx="70" cy="56" r="13" fill="#020617" />
      <Circle cx="107" cy="56" r="13" fill="#020617" />
      <Circle cx="103" cy="52" r="9" fill="#ffe59a" />
      <Line x1="103" y1="35" x2="103" y2="69" stroke="#fff7c2" strokeWidth="2" />
      <Line x1="86" y1="52" x2="120" y2="52" stroke="#fff7c2" strokeWidth="2" />
      <Path d="M105 80 C132 78 145 96 138 122 L126 178 C122 194 110 204 94 199 L69 191 C54 186 49 173 56 159 L74 123 C80 111 82 98 86 88 C90 82 96 80 105 80 Z" fill="#ffd0bd" stroke="#f2a08d" strokeWidth="2" />
      <Circle cx="96" cy="189" r="18" fill="#39b980" />
      <Path d="M88 188 L94 194 L106 181" stroke="#fff" strokeWidth="5" fill="none" strokeLinecap="round" />
    </Svg>
  );
}

function BellArt() {
  return (
    <Svg width={180} height={150} viewBox="0 0 180 150">
      <Path d="M90 28 C62 28 48 48 48 78 V98 L34 116 H146 L132 98 V78 C132 48 118 28 90 28 Z" fill="#ffcc4d" />
      <Circle cx="90" cy="122" r="12" fill="#f59e0b" />
      <Path d="M62 38 C50 29 38 30 28 40 M118 38 C130 29 142 30 152 40" stroke="#ffb020" strokeWidth="6" fill="none" strokeLinecap="round" />
    </Svg>
  );
}

function ClipboardArt() {
  return (
    <Svg width={170} height={150} viewBox="0 0 170 150">
      <Rect x="46" y="26" width="78" height="104" rx="12" fill="#eef2f7" stroke="#cfd8e3" strokeWidth="4" />
      <Rect x="66" y="14" width="38" height="24" rx="8" fill="#9aa4b2" />
      <Path d="M92 112 C73 99 64 88 64 76 C64 66 71 60 80 60 C86 60 90 64 92 69 C95 64 99 60 105 60 C114 60 121 66 121 76 C121 88 112 99 92 112 Z" fill={rose} />
    </Svg>
  );
}

const dictionary = {
  vi: {
    appTitle: 'APP ĐO NHỊP TIM', appSub: 'Theo dõi sức khỏe tim mạch mỗi ngày', helpUpper: 'TRỢ GIÚP', measureUpper: 'ĐO', historyUpper: 'LỊCH SỬ',
    hello: 'Xin chào!', badSignal: 'Tín hiệu không tốt', result: 'Kết quả đo', measuring: 'Đang đo', coverCamera: 'Đặt ngón tay che kín camera và giữ yên.', holdStill: 'Giữ yên tay, đừng di chuyển.', tapStart: 'Bấm vòng tròn để bắt đầu đo.', chooseMetric: 'Chọn chỉ số bạn muốn đo', startMeasure: 'Bắt đầu đo', stop: 'Dừng đo', retry: 'Thử lại', retryUpper: 'ĐO LẠI', seconds: 'giây', fingerPosition: 'Vị trí đặt tay', historyHint: 'Lịch sử kết quả nằm trong tab Lịch sử',
    heartRate: 'Nhịp tim', spo2: 'SpO2', respiration: 'Nhịp thở', hrv: 'HRV', stress: 'Căng thẳng',
    heartRateDesc: 'Đo nhịp tim từ tín hiệu camera.', spo2Desc: 'Ước tính độ bão hòa oxy trong máu.', respirationDesc: 'Theo dõi tốc độ thở từ nhịp biến thiên.', hrvDesc: 'Độ biến thiên nhịp tim tham khảo.', stressDesc: 'Đánh giá căng thẳng từ nhịp tim.',
    settings: 'Cài đặt', heartUnit: 'Đơn vị nhịp tim', reminder: 'Nhắc nhở đo nhịp tim', reminderTime: 'Thời gian nhắc', lightTheme: 'Chủ đề sáng', language: 'Ngôn ngữ', guide: 'Hướng dẫn sử dụng', exportData: 'Xuất dữ liệu', privacy: 'Chính sách bảo mật', localOnly: 'Đã lưu cục bộ', about: 'Giới thiệu ứng dụng', version: 'Phiên bản 1.0.0', replayOnboarding: 'Xem lại onboarding', on: 'Bật', off: 'Tắt',
    historyTitle: 'Lịch sử đo', day: 'Ngày', week: 'Tuần', month: 'Tháng', emptyHistory: 'Lịch sử trống', demoHistoryHint: 'Bạn chưa có dữ liệu thật. Danh sách bên dưới là dữ liệu mẫu để xem giao diện.', home: 'Trang chủ', history: 'Lịch sử', stats: 'Thống kê',
    average: 'Trung bình', highest: 'Cao nhất', lowest: 'Thấp nhất', heartZones: 'Vùng nhịp tim', lowZone: 'Thấp (<60)', normalZone: 'Bình thường (60-100)', highZone: 'Cao (>100)',
    guideTitle: 'Hướng dẫn đo', guide1Title: 'Đặt ngón tay', guide1Text: 'Đặt đầu ngón tay che kín camera và đèn flash.', guide2Title: 'Giữ yên tay', guide2Text: 'Giữ tay ổn định trong 15-30 giây để có kết quả chính xác.', guide3Title: 'Chờ kết quả', guide3Text: 'Ứng dụng sẽ phân tích và hiển thị nhịp tim của bạn.', gotItStart: 'Hiểu rồi, bắt đầu đo', fingerInstruction: 'Đặt ngón tay che kín camera và đèn flash', fingerHint: 'Giữ yên tay và không ấn quá mạnh để tín hiệu ổn định hơn.',
    detailTitle: 'Chi tiết kết quả', note: 'Ghi chú', activity: 'Hoàn cảnh đo', duration: 'Thời gian đo', confidence: 'Độ tin cậy', reminderTitle: 'Nhắc nhở đo nhịp tim', reminderBig: 'Đã đến lúc kiểm tra nhịp tim của bạn!', reminderSub: 'Duy trì thói quen tốt để bảo vệ sức khỏe tim mạch.', dailyReminder: 'Nhắc mỗi ngày lúc 09:00', measureNow: 'Đo ngay', exportPdf: 'Xuất PDF', exportExcel: 'Xuất Excel', exportCsv: 'Xuất CSV', exportReady: 'Chức năng xuất dữ liệu đã sẵn sàng.', noHistory: 'Bạn chưa có lịch sử đo nào', startFirst: 'Hãy bắt đầu đo nhịp tim ngay.',
    yourResult: 'Kết quả', status: 'Trạng thái', resting: 'Nghỉ ngơi', afterWorkout: 'Sau tập', sitting: 'Đang ngồi', active: 'Vận động', notePlaceholder: 'Nhập ghi chú của bạn', measureAgain: 'Đo lại', continue: 'Tiếp tục', startNow: 'Bắt đầu ngay', later: 'Để sau',
    onboardHeartTitle: 'Theo dõi nhịp tim của bạn', onboardHeartText: 'Đo nhịp tim nhanh chóng, chính xác bằng camera điện thoại.', onboardPrivacyTitle: 'An toàn & Bảo mật', onboardPrivacyText: 'Dữ liệu được lưu trên máy của bạn và không chia sẻ với bên thứ ba.', onboardTrackTitle: 'Lưu trữ & Theo dõi', onboardTrackText: 'Xem lịch sử, biểu đồ và theo dõi sức khỏe tim mạch theo thời gian.', onboardStartTitle: 'Sẵn sàng bắt đầu', onboardStartText: 'Hãy đảm bảo bạn ở nơi đủ sáng và giữ tay ổn định khi đo.',
    normal: 'Bình thường', low: 'Thấp', high: 'Cao', medium: 'Trung bình', good: 'Tốt', watch: 'Cần theo dõi', waitingSignal: 'Đang chờ tín hiệu', levelUpper: 'MỨC',
  },
  en: {
    appTitle: 'HEART RATE APP', appSub: 'Track your heart health every day', helpUpper: 'HELP', measureUpper: 'MEASURE', historyUpper: 'HISTORY',
    hello: 'Hello!', badSignal: 'Poor signal', result: 'Result', measuring: 'Measuring', coverCamera: 'Cover the camera fully and keep still.', holdStill: 'Keep your finger still.', tapStart: 'Tap the circle to start.', chooseMetric: 'Choose a metric to measure', startMeasure: 'Start measuring', stop: 'Stop', retry: 'Retry', retryUpper: 'RETRY', seconds: 'sec', fingerPosition: 'Finger position', historyHint: 'Results are saved in History',
    heartRate: 'Heart rate', spo2: 'SpO2', respiration: 'Respiration', hrv: 'HRV', stress: 'Stress',
    heartRateDesc: 'Measure heart rate from camera signal.', spo2Desc: 'Estimate blood oxygen saturation.', respirationDesc: 'Track breathing rate from pulse variation.', hrvDesc: 'Reference heart rate variability.', stressDesc: 'Estimate stress from heart signal.',
    settings: 'Settings', heartUnit: 'Heart rate unit', reminder: 'Heart rate reminder', reminderTime: 'Reminder time', lightTheme: 'Light theme', language: 'Language', guide: 'User guide', exportData: 'Export data', privacy: 'Privacy policy', localOnly: 'Stored locally', about: 'About app', version: 'Version 1.0.0', replayOnboarding: 'Replay onboarding', on: 'On', off: 'Off',
    historyTitle: 'Measurement History', day: 'Day', week: 'Week', month: 'Month', emptyHistory: 'Empty history', demoHistoryHint: 'No real data yet. The list below is sample data for preview.', home: 'Home', history: 'History', stats: 'Stats',
    average: 'Average', highest: 'Highest', lowest: 'Lowest', heartZones: 'Heart zones', lowZone: 'Low (<60)', normalZone: 'Normal (60-100)', highZone: 'High (>100)',
    guideTitle: 'Measurement Guide', guide1Title: 'Place finger', guide1Text: 'Cover the camera and flash with your fingertip.', guide2Title: 'Keep still', guide2Text: 'Hold steady for 15-30 seconds for a better result.', guide3Title: 'Wait for result', guide3Text: 'The app analyzes your signal and shows the result.', gotItStart: 'Got it, start', fingerInstruction: 'Cover the camera and flash with your finger', fingerHint: 'Keep still and do not press too hard.',
    detailTitle: 'Result details', note: 'Note', activity: 'Activity', duration: 'Duration', confidence: 'Confidence', reminderTitle: 'Heart rate reminder', reminderBig: 'Time to check your heart rate!', reminderSub: 'Keep a healthy tracking habit.', dailyReminder: 'Daily reminder at 09:00', measureNow: 'Measure now', exportPdf: 'Export PDF', exportExcel: 'Export Excel', exportCsv: 'Export CSV', exportReady: 'Data export is ready.', noHistory: 'You have no measurement history', startFirst: 'Start measuring now.',
    yourResult: 'Your result', status: 'Status', resting: 'Resting', afterWorkout: 'After workout', sitting: 'Sitting', active: 'Active', notePlaceholder: 'Enter your note', measureAgain: 'Measure again', continue: 'Continue', startNow: 'Start now', later: 'Later',
    onboardHeartTitle: 'Track your heart rate', onboardHeartText: 'Measure your heart rate quickly using the phone camera.', onboardPrivacyTitle: 'Safe & Private', onboardPrivacyText: 'Your data stays on your phone and is not shared.', onboardTrackTitle: 'Store & Track', onboardTrackText: 'View history, charts, and long-term heart health.', onboardStartTitle: 'Ready to start', onboardStartText: 'Use good lighting and keep your finger steady.',
    normal: 'Normal', low: 'Low', high: 'High', medium: 'Medium', good: 'Good', watch: 'Watch', waitingSignal: 'Waiting for signal', levelUpper: 'LEVEL',
  },
} as const;

function tx(language: Language, key: keyof typeof dictionary.vi) {
  return dictionary[language][key] ?? dictionary.vi[key];
}

function metricNameFor(metric: MetricKey, language: Language) {
  return tx(language, metric);
}

function metricDescriptionFor(metric: MetricKey, language: Language) {
  return tx(language, `${metric}Desc` as keyof typeof dictionary.vi);
}

function stressLabel(value: string | undefined, language: Language) {
  if (value === 'Cao') return tx(language, 'high');
  if (value === 'Trung bình') return tx(language, 'medium');
  return tx(language, 'low');
}

function makeDemo(id: string, metric: MetricKey, value: number, unit: string, bpm: number, hoursAgo: number): Measurement {
  const definition = healthMetrics.find((item) => item.key === metric) ?? healthMetrics[0];
  const derived = deriveHealthValues(bpm, 0.95, metric === 'spo2' ? value : undefined, metric === 'respiration' ? value : undefined);
  return {
    id,
    metric,
    label: definition.label,
    value,
    unit,
    bpm,
    ...derived,
    quality: 0.92,
    durationMs: 30000,
    createdAt: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
  };
}

function migrateMeasurement(item: Partial<Measurement> & { bpm: number; id?: string; createdAt?: string }): Measurement {
  const metric = item.metric ?? 'heartRate';
  const definition = healthMetrics.find((metricItem) => metricItem.key === metric) ?? healthMetrics[0];
  const derived = deriveHealthValues(item.bpm, item.quality ?? 0.9, item.spO2, item.respiration);
  const shouldRepairUnit = metric !== 'heartRate' && item.unit === 'BPM';
  return {
    id: item.id ?? `${Date.now()}`,
    metric,
    label: item.label ?? definition.label,
    value: item.value ?? valueForMetric(metric, item.bpm, derived),
    unit: shouldRepairUnit ? definition.unit : item.unit ?? definition.unit,
    bpm: item.bpm,
    ...derived,
    quality: item.quality ?? 0.9,
    durationMs: item.durationMs ?? 30000,
    createdAt: item.createdAt ?? new Date().toISOString(),
    activity: item.activity,
    note: item.note,
  };
}

function deriveHealthValues(bpm: number, quality: number, measuredSpO2?: number, measuredRespiration?: number) {
  const qualityBonus = Math.round(Math.max(0, Math.min(quality, 1)) * 2);
  const spO2 = measuredSpO2 ?? Math.max(94, Math.min(99, 99 - Math.max(0, Math.round((bpm - 92) / 18)) - (quality < 0.65 ? 1 : 0)));
  const respiration = measuredRespiration ?? Math.max(12, Math.min(22, Math.round(12 + bpm / 18)));
  const hrv = Math.max(25, Math.min(86, Math.round(88 - bpm * 0.55 + qualityBonus * 4)));
  const stress = bpm > 100 || hrv < 38 ? 'Cao' : bpm > 86 || hrv < 50 ? 'Trung bình' : 'Thấp';
  return { spO2, respiration, hrv, stress };
}

function valueForMetric(metric: MetricKey, bpm: number, derived: ReturnType<typeof deriveHealthValues>) {
  if (metric === 'spo2') return derived.spO2 ?? 0;
  if (metric === 'respiration') return derived.respiration ?? 0;
  if (metric === 'hrv') return derived.hrv;
  if (metric === 'stress') return derived.stress === 'Cao' ? 3 : derived.stress === 'Trung bình' ? 2 : 1;
  return bpm;
}

function displayValueForMetricFromBpm(metric: MetricKey, bpm: number, quality: number) {
  const derived = deriveHealthValues(bpm, quality);
  const value = valueForMetric(metric, bpm, derived);
  return typeof value === 'number' ? value : bpm;
}

function displayUnitForMetric(metric: MetricKey, language: Language = 'vi') {
  if (metric === 'stress') return tx(language, 'levelUpper');
  return healthMetrics.find((item) => item.key === metric)?.unit ?? 'BPM';
}

function formatMetricValue(item: Measurement, language: Language = 'vi') {
  if (item.metric === 'stress') return stressLabel(item.stress, language);
  return `${item.value}${item.unit ? ` ${item.unit}` : ''}`;
}

function statusForMeasurement(item: Measurement, language: Language = 'vi') {
  if (item.metric === 'spo2') return item.value >= 95 ? tx(language, 'normal') : tx(language, 'low');
  if (item.metric === 'respiration') return item.value >= 12 && item.value <= 20 ? tx(language, 'normal') : tx(language, 'watch');
  if (item.metric === 'hrv') return item.value >= 50 ? tx(language, 'good') : item.value >= 35 ? tx(language, 'medium') : tx(language, 'low');
  if (item.metric === 'stress') return stressLabel(item.stress, language);
  return statusByBpm(item.bpm, language);
}

function metricIsHigh(item: Measurement) {
  return ['Cao', 'Cần theo dõi'].includes(statusForMeasurement(item));
}

function normalize(value: number, minValue: number, maxValue: number) {
  return (value - minValue) / Math.max(maxValue - minValue, 1);
}

function previousText(latest?: Measurement) {
  if (!latest) return 'Kết quả trước: Chưa có';
  return `Kết quả trước: ${latest.bpm} BPM (${formatDate(latest.createdAt)})`;
}

function statusByBpm(bpm?: number, language: Language = 'vi') {
  if (!bpm) return tx(language, 'waitingSignal');
  if (bpm < 60) return tx(language, 'low');
  if (bpm > 100) return tx(language, 'high');
  return tx(language, 'normal');
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(value));
}

function timeOnly(value: string) {
  return new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function dateOnly(value: string) {
  return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(value));
}

function groupHistory(items: Measurement[], period: HistoryPeriod, language: Language) {
  const groups = new Map<string, Measurement[]>();
  items.forEach((item) => {
    const title = period === 'day' ? dayGroupTitle(item.createdAt, language) : period === 'week' ? weekGroupTitle(item.createdAt, language) : monthGroupTitle(item.createdAt, language);
    groups.set(title, [...(groups.get(title) ?? []), item]);
  });
  return Array.from(groups.entries()).map(([title, groupItems]) => ({ title, items: groupItems }));
}

function dayGroupTitle(value: string, language: Language) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (sameDate(date, today)) return language === 'vi' ? 'Hôm nay' : 'Today';
  if (sameDate(date, yesterday)) return language === 'vi' ? 'Hôm qua' : 'Yesterday';
  return dateOnly(value);
}

function weekGroupTitle(value: string, language: Language) {
  const date = new Date(value);
  const start = startOfWeek(date);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return `${language === 'vi' ? 'Tuần' : 'Week'} ${dateOnly(start.toISOString())} - ${dateOnly(end.toISOString())}`;
}

function monthGroupTitle(value: string, language: Language) {
  return new Intl.DateTimeFormat(language === 'vi' ? 'vi-VN' : 'en-US', { month: 'long', year: 'numeric' }).format(new Date(value));
}

function startOfWeek(date: Date) {
  const start = new Date(date);
  const day = start.getDay() || 7;
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - day + 1);
  return start;
}

function sameDate(left: Date, right: Date) {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
}

function errorToText(error: unknown) {
  if (error instanceof Error) return `${error.name}: ${error.message}\n${error.stack ?? ''}`;
  return safeJson(error);
}

function safeJson(value: unknown) {
  try {
    if (typeof value === 'string') return value;
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const styles = StyleSheet.create({
  resultPage: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  resultHeader: {
    alignItems: 'center',
    backgroundColor: '#222222',
    flexDirection: 'row',
    height: 52,
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  resultBack: {
    color: '#ffffff',
    fontSize: 34,
    fontWeight: '300',
    lineHeight: 36,
    width: 34,
  },
  resultHeaderTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '800',
  },
  resultMenu: {
    color: '#ffffff',
    fontSize: 19,
    fontWeight: '900',
    width: 34,
  },
  resultContent: {
    alignItems: 'center',
    padding: 20,
    paddingBottom: 34,
  },
  resultTopBpm: {
    color: '#1f2328',
    fontSize: 40,
    fontWeight: '400',
    marginTop: 4,
  },
  resultTopDate: {
    color: '#23272f',
    fontSize: 19,
    marginTop: 8,
    marginBottom: 22,
  },
  resultSummary: {
    color: '#222222',
    fontSize: 18,
    marginTop: 20,
    textAlign: 'center',
  },
  resultDisclaimer: {
    color: '#667085',
    fontSize: 13,
    fontWeight: '800',
    marginTop: 8,
    textAlign: 'center',
  },
  resultQuality: {
    color: '#373b42',
    fontSize: 18,
    marginTop: 8,
    textAlign: 'center',
  },
  activityRow: {
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
    marginTop: 28,
    width: '100%',
  },
  activityOption: {
    alignItems: 'center',
    flex: 1,
  },
  activityCircle: {
    alignItems: 'center',
    borderColor: '#9ca3af',
    borderRadius: 34,
    borderWidth: 1.3,
    height: 68,
    justifyContent: 'center',
    width: 68,
  },
  activityCircleActive: {
    borderColor: rose,
    borderWidth: 2,
  },
  activityIcon: {
    color: '#42464d',
    fontSize: 32,
    fontWeight: '500',
  },
  activityIconActive: {
    color: rose,
  },
  activityCheck: {
    backgroundColor: rose,
    borderRadius: 11,
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '900',
    height: 22,
    lineHeight: 22,
    position: 'absolute',
    right: 2,
    textAlign: 'center',
    top: -3,
    width: 22,
  },
  activityText: {
    color: '#39404a',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 7,
    textAlign: 'center',
  },
  activityLabel: {
    color: '#333333',
    fontSize: 18,
    marginTop: 10,
    marginBottom: 24,
    textAlign: 'center',
  },
  resultNoteInput: {
    alignSelf: 'stretch',
    borderColor: '#55b5ae',
    borderRadius: 6,
    borderWidth: 1.8,
    color: '#1f2937',
    fontSize: 17,
    minHeight: 48,
    paddingHorizontal: 10,
    paddingVertical: 10,
    textAlignVertical: 'top',
  },
  resultWaveBox: {
    alignItems: 'center',
    alignSelf: 'stretch',
    backgroundColor: '#ffffff',
    borderColor: '#cfd4db',
    borderWidth: 1,
    marginTop: 92,
    overflow: 'hidden',
  },
  resultActionRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 30,
    width: '100%',
  },
  resultSecondaryButton: {
    alignItems: 'center',
    borderColor: '#e5e7eb',
    borderRadius: 9,
    borderWidth: 1,
    flex: 0.45,
    height: 54,
    justifyContent: 'center',
  },
  resultSecondaryText: {
    color: rose,
    fontSize: 17,
    fontWeight: '800',
  },
  resultPrimaryButton: {
    alignItems: 'center',
    backgroundColor: rose,
    borderRadius: 9,
    flex: 1,
    height: 54,
    justifyContent: 'center',
  },
  resultPrimaryText: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '800',
  },
  darkSafe: {
    flex: 1,
    backgroundColor: navy,
  },
  lightSafe: {
    flex: 1,
    backgroundColor: '#f7f8fb',
  },
  measurePage: {
    flex: 1,
    backgroundColor: navy,
    paddingBottom: 76,
  },
  darkHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
    paddingTop: 12,
    paddingBottom: 14,
  },
  brand: {
    color: '#ff6685',
    fontSize: 23,
    fontWeight: '900',
    letterSpacing: 0,
  },
  brandSub: {
    color: '#b7c1cd',
    fontSize: 13,
    marginTop: 3,
  },
  roundIcon: {
    alignItems: 'center',
    borderColor: '#24445b',
    borderRadius: 18,
    borderWidth: 1,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  roundIconText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
  },
  measureTabs: {
    alignItems: 'center',
    borderBottomColor: '#123148',
    borderBottomWidth: 1,
    flexDirection: 'row',
    height: 56,
    justifyContent: 'space-around',
  },
  measureTab: {
    color: '#a9b8c6',
    fontSize: 15,
    fontWeight: '900',
  },
  measureTabActive: {
    color: '#ffffff',
    borderBottomColor: rose,
    borderBottomWidth: 3,
    paddingBottom: 17,
  },
  measureBody: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  metricPickerPanel: {
    alignSelf: 'stretch',
    gap: 10,
    justifyContent: 'center',
  },
  metricPickerTitle: {
    color: '#ffffff',
    fontSize: 19,
    fontWeight: '900',
    marginBottom: 8,
  },
  metricPickRow: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderColor: '#16354e',
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    minHeight: 58,
    paddingHorizontal: 12,
  },
  metricPickRowActive: {
    borderColor: rose,
    borderWidth: 2,
  },
  metricPickIcon: {
    alignItems: 'center',
    borderRadius: 18,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  metricPickIconText: {
    fontSize: 21,
    fontWeight: '900',
  },
  metricPickContent: {
    flex: 1,
  },
  metricPickTitle: {
    color: ink,
    fontSize: 14,
    fontWeight: '900',
  },
  metricPickDescription: {
    color: muted,
    fontSize: 11,
    lineHeight: 15,
    marginTop: 3,
  },
  spo2Disclaimer: {
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: '800',
    textAlign: 'center',
  },
  measureTitle: {
    color: '#ffffff',
    fontSize: 19,
    fontWeight: '900',
    marginBottom: 28,
  },
  dialButton: {
    alignItems: 'center',
    height: dialSize,
    justifyContent: 'center',
    width: dialSize,
  },
  absoluteSvg: {
    left: 0,
    position: 'absolute',
    top: 0,
  },
  measureHeart: {
    color: rose,
    fontSize: 46,
    fontWeight: '900',
  },
  faceIcon: {
    color: rose,
    fontSize: 76,
    fontWeight: '900',
    marginBottom: 8,
  },
  measureBpm: {
    color: '#ffffff',
    fontSize: 72,
    fontVariant: ['tabular-nums'],
    fontWeight: '900',
    lineHeight: 78,
  },
  measureUnit: {
    color: '#dce5ef',
    fontSize: 18,
    fontWeight: '700',
  },
  measureHint: {
    color: '#d5dde6',
    fontSize: 15,
    marginTop: 22,
    textAlign: 'center',
  },
  waveSvg: {
    marginTop: 18,
  },
  notePanel: {
    alignSelf: 'stretch',
    backgroundColor: navy2,
    borderColor: '#24445b',
    borderRadius: 16,
    borderWidth: 1,
    gap: 10,
    marginTop: 14,
    padding: 14,
  },
  noteTitle: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '900',
  },
  noteInput: {
    backgroundColor: '#0b2b45',
    borderColor: '#31516a',
    borderRadius: 12,
    borderWidth: 1,
    color: '#ffffff',
    fontSize: 14,
    minHeight: 78,
    paddingHorizontal: 12,
    paddingVertical: 10,
    textAlignVertical: 'top',
  },
  noteActions: {
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'flex-end',
  },
  noteSkipButton: {
    alignItems: 'center',
    borderColor: '#31516a',
    borderRadius: 10,
    borderWidth: 1,
    minHeight: 42,
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  noteSkipText: {
    color: '#dce8f3',
    fontSize: 13,
    fontWeight: '800',
  },
  noteSaveButton: {
    alignItems: 'center',
    backgroundColor: rose,
    borderRadius: 10,
    minHeight: 42,
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  noteSaveText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '900',
  },
  measureActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 18,
  },
  darkGhostButton: {
    alignItems: 'center',
    borderColor: '#31516a',
    borderRadius: 12,
    borderWidth: 1,
    minHeight: 46,
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  darkGhostText: {
    color: '#dce8f3',
    fontSize: 14,
    fontWeight: '800',
  },
  primaryButtonSmall: {
    alignItems: 'center',
    backgroundColor: rose,
    borderRadius: 12,
    minHeight: 46,
    justifyContent: 'center',
    paddingHorizontal: 22,
  },
  previousDark: {
    color: '#a9b8c6',
    fontSize: 13,
    marginTop: 16,
    textAlign: 'center',
  },
  bottomTabs: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderTopColor: '#edf0f5',
    borderTopWidth: 1,
    bottom: 0,
    flexDirection: 'row',
    height: 76,
    justifyContent: 'space-around',
    left: 0,
    position: 'absolute',
    right: 0,
  },
  bottomTab: {
    alignItems: 'center',
    flex: 1,
    gap: 3,
  },
  bottomIcon: {
    color: '#8b95a1',
    fontSize: 22,
  },
  bottomLabel: {
    color: '#8b95a1',
    fontSize: 11,
    fontWeight: '800',
  },
  bottomActive: {
    color: rose,
  },
  lightPage: {
    flex: 1,
    backgroundColor: '#f7f8fb',
  },
  lightHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    height: 58,
    justifyContent: 'space-between',
    paddingHorizontal: 18,
  },
  headerSlot: {
    width: 34,
  },
  backText: {
    color: ink,
    fontSize: 36,
    fontWeight: '300',
    lineHeight: 38,
    width: 34,
  },
  lightTitle: {
    color: ink,
    fontSize: 18,
    fontWeight: '900',
  },
  scrollContent: {
    gap: 16,
    padding: 18,
    paddingBottom: 104,
  },
  onboardWrap: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    padding: 30,
  },
  onboardArt: {
    height: 190,
    justifyContent: 'center',
  },
  onboardTitle: {
    color: ink,
    fontSize: 25,
    fontWeight: '900',
    marginTop: 14,
    textAlign: 'center',
  },
  onboardText: {
    color: muted,
    fontSize: 15,
    lineHeight: 23,
    marginTop: 12,
    textAlign: 'center',
  },
  primaryButton: {
    alignItems: 'center',
    alignSelf: 'stretch',
    backgroundColor: rose,
    borderRadius: 12,
    height: 52,
    justifyContent: 'center',
    marginTop: 24,
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '900',
  },
  skipText: {
    color: muted,
    fontSize: 14,
    fontWeight: '700',
    marginTop: 16,
  },
  dots: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 22,
  },
  dot: {
    backgroundColor: '#d1d5db',
    borderRadius: 4,
    height: 7,
    width: 7,
  },
  dotActive: {
    backgroundColor: rose,
    width: 16,
  },
  segmented: {
    backgroundColor: '#f0f2f6',
    borderRadius: 12,
    flexDirection: 'row',
    padding: 4,
  },
  segment: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingVertical: 9,
  },
  segmentActive: {
    backgroundColor: rose,
    borderRadius: 9,
    overflow: 'hidden',
  },
  segmentText: {
    color: muted,
    fontSize: 13,
    fontWeight: '800',
    textAlign: 'center',
  },
  segmentTextActive: {
    color: '#ffffff',
  },
  sectionLabel: {
    color: ink,
    fontSize: 15,
    fontWeight: '900',
    marginTop: 4,
  },
  historyRow: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderColor: line,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    minHeight: 58,
    paddingHorizontal: 14,
  },
  historyTime: {
    color: ink,
    fontSize: 14,
    width: 58,
  },
  historyHeart: {
    color: rose,
    fontSize: 17,
    width: 26,
  },
  historyMain: {
    flex: 1,
  },
  historyBpm: {
    color: ink,
    fontSize: 15,
    fontWeight: '900',
  },
  historyNote: {
    color: muted,
    fontSize: 12,
    fontWeight: '700',
    marginTop: 3,
  },
  historyStatus: {
    color: '#16a34a',
    fontSize: 13,
    fontWeight: '800',
  },
  historyStatusHigh: {
    color: roseDark,
  },
  emptyHint: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderColor: line,
    borderRadius: 18,
    borderWidth: 1,
    padding: 16,
  },
  emptyTitle: {
    color: ink,
    fontSize: 17,
    fontWeight: '900',
  },
  emptyText: {
    color: muted,
    fontSize: 13,
    lineHeight: 20,
    marginTop: 6,
    textAlign: 'center',
  },
  card: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderColor: line,
    borderRadius: 18,
    borderWidth: 1,
    padding: 14,
  },
  summaryGrid: {
    flexDirection: 'row',
    gap: 10,
  },
  metric: {
    backgroundColor: '#ffffff',
    borderColor: line,
    borderRadius: 16,
    borderWidth: 1,
    flex: 1,
    padding: 14,
  },
  metricLabel: {
    color: muted,
    fontSize: 12,
    fontWeight: '800',
  },
  metricValue: {
    color: ink,
    fontSize: 22,
    fontWeight: '900',
    marginTop: 8,
  },
  metricAccent: {
    color: rose,
  },
  metricSuffix: {
    color: muted,
    fontSize: 11,
    fontWeight: '800',
  },
  legend: {
    alignSelf: 'stretch',
    gap: 8,
    marginTop: 8,
  },
  legendRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  legendDot: {
    borderRadius: 5,
    height: 10,
    width: 10,
  },
  legendLabel: {
    color: ink,
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
  },
  legendValue: {
    color: muted,
    fontSize: 13,
    fontWeight: '800',
  },
  settingRow: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderColor: line,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 56,
    paddingHorizontal: 14,
  },
  settingSwitchRow: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderColor: line,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 56,
    paddingHorizontal: 14,
  },
  settingLeft: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  settingIcon: {
    color: rose,
    fontSize: 18,
    fontWeight: '900',
    width: 24,
  },
  settingTitle: {
    color: ink,
    fontSize: 14,
    fontWeight: '800',
  },
  settingRight: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  settingValue: {
    color: muted,
    fontSize: 13,
    fontWeight: '700',
  },
  chevron: {
    color: '#a6afbb',
    fontSize: 24,
  },
  secondaryButton: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderColor: line,
    borderRadius: 14,
    borderWidth: 1,
    height: 50,
    justifyContent: 'center',
  },
  secondaryText: {
    color: rose,
    fontSize: 14,
    fontWeight: '900',
  },
  guideStep: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderColor: line,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 14,
    padding: 16,
  },
  stepNumber: {
    backgroundColor: '#fff0f4',
    borderRadius: 18,
    color: rose,
    fontSize: 16,
    fontWeight: '900',
    height: 36,
    lineHeight: 36,
    textAlign: 'center',
    width: 36,
  },
  stepTitle: {
    color: ink,
    fontSize: 15,
    fontWeight: '900',
  },
  stepText: {
    color: muted,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 4,
  },
  bigInstruction: {
    color: ink,
    fontSize: 21,
    fontWeight: '900',
    textAlign: 'center',
  },
  centerMuted: {
    color: muted,
    fontSize: 14,
    lineHeight: 22,
    textAlign: 'center',
  },
  detailDate: {
    color: muted,
    fontSize: 13,
    fontWeight: '800',
    textAlign: 'center',
  },
  resultWrap: {
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderColor: line,
    borderRadius: 20,
    borderWidth: 1,
    padding: 20,
  },
  heartResultSvg: {
    position: 'absolute',
    top: 18,
  },
  resultBpm: {
    color: ink,
    fontSize: 58,
    fontWeight: '900',
    marginTop: 44,
  },
  resultUnit: {
    color: ink,
    fontSize: 15,
    fontWeight: '900',
  },
  resultStatus: {
    color: '#16a34a',
    fontSize: 17,
    fontWeight: '900',
    marginTop: 28,
  },
  rangeWrap: {
    backgroundColor: '#ffffff',
    borderColor: line,
    borderRadius: 18,
    borderWidth: 1,
    padding: 16,
  },
  rangeLine: {
    flexDirection: 'row',
    height: 6,
    overflow: 'hidden',
    borderRadius: 999,
  },
  rangePart: {
    flex: 1,
  },
  rangeMarker: {
    backgroundColor: ink,
    borderRadius: 5,
    height: 10,
    marginTop: -8,
    position: 'absolute',
    top: 16,
    width: 10,
  },
  rangeLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  rangeLabel: {
    color: muted,
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
  },
  noticeBox: {
    backgroundColor: '#ffffff',
    borderColor: line,
    borderRadius: 18,
    borderWidth: 1,
    padding: 18,
  },
  noticeText: {
    color: ink,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
  },
  noteDetailLabel: {
    color: rose,
    fontSize: 13,
    fontWeight: '900',
    marginBottom: 8,
    textAlign: 'center',
  },
});

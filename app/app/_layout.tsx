import { Stack, useRouter, useSegments } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, Platform, StatusBar as RNStatusBar, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useAuth } from "@/store/auth";
import { useUi } from "@/store/ui";
import { setupNotifications, ensureNotificationPermission, addNotificationResponseListener } from "@/notify";
import { useGlobalNotifier } from "@/hooks/useGlobalNotifier";
import { UiHost } from "@/components/Ui";
import { AchievementHost } from "@/components/AchievementHost";
import { MilestoneHost } from "@/components/MilestoneHost";

export default function RootLayout() {
  const { ready, signedIn, hydrate } = useAuth();
  const hydrateUi = useUi((s) => s.hydrate);
  const segments = useSegments();
  const router = useRouter();

  // 立即把状态栏设成 translucent + 浅色，避免首次启动时未生效
  useEffect(() => {
    if (Platform.OS === "android") {
      RNStatusBar.setTranslucent(true);
      RNStatusBar.setBackgroundColor("transparent");
    }
    RNStatusBar.setBarStyle("light-content", true);
  }, []);

  useEffect(() => { hydrate(); hydrateUi(); }, [hydrate, hydrateUi]);

  // 初始化通知 + 申请权限 + 监听点通知（Expo Go 下静默降级为 no-op）
  useEffect(() => {
    setupNotifications();
    ensureNotificationPermission();
    let sub: { remove: () => void } | null = null;
    addNotificationResponseListener((sessionId) => {
      if (sessionId) router.push(`/chat/${sessionId}`);
    }).then((s) => { sub = s; });
    return () => { sub?.remove(); };
  }, [router]);

  // 全局 WS：在 App 任何位置都能收来电 / 主动消息，决定是否弹本地通知
  useGlobalNotifier();

  useEffect(() => {
    if (!ready) return;
    const inAuth = segments[0] === "auth";
    if (!signedIn && !inAuth) router.replace("/auth/login");
    else if (signedIn && inAuth) router.replace("/");
  }, [ready, signedIn, segments, router]);

  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0f0f17" }}>
        <ActivityIndicator color="#7e6fd0" />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: "#0f0f17" }}>
      <SafeAreaProvider style={{ backgroundColor: "#0f0f17" }}>
      <StatusBar style="light" translucent backgroundColor="transparent" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#0f0f17" } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="auth/login" />
        <Stack.Screen name="auth/register" />
        <Stack.Screen name="chat/[sessionId]" />
        <Stack.Screen name="character/new" />
        <Stack.Screen name="character/edit/[id]" />
        <Stack.Screen name="character/voice" />
        <Stack.Screen name="character/affection" />
        <Stack.Screen name="character/gallery" />
        <Stack.Screen name="character/milestones/index" />
        <Stack.Screen name="character/milestones/[id]" />
        <Stack.Screen name="character/calls/index" />
        <Stack.Screen name="achievements/index" />
        <Stack.Screen name="achievements/[id]" />
      </Stack>
      <UiHost />
      <AchievementHost />
      <MilestoneHost />
    </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

import { useEffect, useRef, useState } from "react";
import {
  Animated, Easing, Modal, Pressable, StyleSheet, Text, View,
} from "react-native";
import * as Haptics from "expo-haptics";

// 轻触觉反馈（删除/确认等操作），不支持的设备静默忽略
export function hapticLight() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

// ────────────────────────────────────────────────────────────
// confirm() / alert() / toast() — 全局调用，告别原生 Alert.alert
// ────────────────────────────────────────────────────────────

type ConfirmOptions = {
  title?: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
};

export type ActionSheetItem = {
  label: string;
  destructive?: boolean;
  onPress?: () => void | Promise<void>;
};

let confirmHandler: ((opts: ConfirmOptions) => Promise<boolean>) | null = null;
let toastHandler: ((msg: string, kind?: "ok" | "err") => void) | null = null;
let actionSheetHandler: ((title: string, items: ActionSheetItem[]) => Promise<void>) | null = null;

export function confirm(opts: ConfirmOptions): Promise<boolean> {
  if (!confirmHandler) return Promise.resolve(false);
  return confirmHandler(opts);
}

export function alertModal(title: string, message?: string): Promise<void> {
  return confirm({ title, message, confirmText: "知道了", cancelText: "" }).then(() => undefined);
}

export function toast(msg: string, kind: "ok" | "err" = "ok") {
  toastHandler?.(msg, kind);
}

export function actionSheet(title: string, items: ActionSheetItem[]): Promise<void> {
  if (!actionSheetHandler) return Promise.resolve();
  return actionSheetHandler(title, items);
}

// ────────────────────────────────────────────────────────────
// <UiHost />：挂在 _layout.tsx 根部，提供一个全局 Modal & Toast 渲染节点
// ────────────────────────────────────────────────────────────

export function UiHost() {
  const [confirmState, setConfirmState] = useState<{
    opts: ConfirmOptions;
    resolve: (v: boolean) => void;
  } | null>(null);
  const [sheetState, setSheetState] = useState<{
    title: string;
    items: ActionSheetItem[];
    resolve: () => void;
  } | null>(null);
  const [toastState, setToastState] = useState<{ msg: string; kind: "ok" | "err"; key: number } | null>(null);
  const toastAnim = useRef(new Animated.Value(0)).current;
  const toastTimer = useRef<any>(null);

  useEffect(() => {
    confirmHandler = (opts) => {
      return new Promise<boolean>((resolve) => {
        setConfirmState({ opts, resolve });
      });
    };
    actionSheetHandler = (title, items) => {
      return new Promise<void>((resolve) => {
        setSheetState({ title, items, resolve });
      });
    };
    toastHandler = (msg, kind = "ok") => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      setToastState({ msg, kind, key: Date.now() });
      toastAnim.setValue(0);
      Animated.timing(toastAnim, { toValue: 1, duration: 220, easing: Easing.out(Easing.ease), useNativeDriver: true }).start();
      toastTimer.current = setTimeout(() => {
        Animated.timing(toastAnim, { toValue: 0, duration: 220, easing: Easing.in(Easing.ease), useNativeDriver: true })
          .start(() => setToastState(null));
      }, 1800);
    };
    return () => { confirmHandler = null; toastHandler = null; actionSheetHandler = null; };
  }, [toastAnim]);

  const closeConfirm = (ok: boolean) => {
    confirmState?.resolve(ok);
    setConfirmState(null);
  };

  const closeSheet = () => {
    sheetState?.resolve();
    setSheetState(null);
  };

  const tapSheetItem = async (it: ActionSheetItem) => {
    sheetState?.resolve();
    setSheetState(null);
    if (it.onPress) await it.onPress();
  };

  return (
    <>
      {/* 确认 / Alert Modal */}
      <Modal
        visible={!!confirmState}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => closeConfirm(false)}
      >
        <Pressable style={s.bg} onPress={() => closeConfirm(false)}>
          <Pressable style={s.card} onPress={(e) => e.stopPropagation()}>
            {confirmState?.opts.title ? (
              <Text style={s.title}>{confirmState.opts.title}</Text>
            ) : null}
            {confirmState?.opts.message ? (
              <Text style={s.message}>{confirmState.opts.message}</Text>
            ) : null}
            <View style={s.btnRow}>
              {confirmState?.opts.cancelText !== "" ? (
                <Pressable style={[s.btn, s.btnGhost]} onPress={() => closeConfirm(false)}>
                  <Text style={s.btnGhostText}>{confirmState?.opts.cancelText || "取消"}</Text>
                </Pressable>
              ) : null}
              <Pressable
                style={[s.btn, confirmState?.opts.destructive ? s.btnDanger : s.btnPrimary]}
                onPress={() => closeConfirm(true)}
              >
                <Text style={s.btnPrimaryText}>{confirmState?.opts.confirmText || "确定"}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Action Sheet */}
      <Modal
        visible={!!sheetState}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={closeSheet}
      >
        <Pressable style={s.sheetBg} onPress={closeSheet}>
          <Pressable style={s.sheetCard} onPress={(e) => e.stopPropagation()}>
            {sheetState?.title ? (
              <Text style={s.sheetTitle}>{sheetState.title}</Text>
            ) : null}
            <View style={s.sheetItems}>
              {sheetState?.items.map((it, idx) => (
                <Pressable
                  key={idx}
                  style={[s.sheetItem, idx > 0 && s.sheetItemBorder]}
                  onPress={() => tapSheetItem(it)}
                >
                  <Text style={[s.sheetItemText, it.destructive && { color: "#f87171" }]}>
                    {it.label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Pressable style={s.sheetCancel} onPress={closeSheet}>
              <Text style={s.sheetCancelText}>取消</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Toast */}
      {toastState ? (
        <Animated.View
          pointerEvents="none"
          style={[
            s.toastWrap,
            {
              opacity: toastAnim,
              transform: [{
                translateY: toastAnim.interpolate({ inputRange: [0, 1], outputRange: [-20, 0] }),
              }],
            },
          ]}
        >
          <View style={[s.toast, toastState.kind === "err" ? s.toastErr : s.toastOk]}>
            <Text style={[s.toastText, toastState.kind === "err" ? { color: "#fca5a5" } : null]}>
              {toastState.msg}
            </Text>
          </View>
        </Animated.View>
      ) : null}
    </>
  );
}

const s = StyleSheet.create({
  bg: {
    flex: 1, backgroundColor: "rgba(8,8,14,0.72)",
    alignItems: "center", justifyContent: "center", padding: 32,
  },
  card: {
    width: "100%", maxWidth: 320,
    backgroundColor: "#1c1c2a",
    borderRadius: 16, borderWidth: 1, borderColor: "#2a2a3a",
    paddingHorizontal: 22, paddingVertical: 22,
    shadowColor: "#000",
    shadowOpacity: 0.45, shadowOffset: { width: 0, height: 10 }, shadowRadius: 30, elevation: 12,
  },
  title: { color: "#fff", fontSize: 17, fontWeight: "700", marginBottom: 10 },
  message: { color: "#bbb", fontSize: 14, lineHeight: 22 },

  btnRow: { flexDirection: "row", gap: 10, marginTop: 20, justifyContent: "flex-end" },
  btn: { paddingHorizontal: 18, paddingVertical: 9, borderRadius: 10, minWidth: 76, alignItems: "center" },
  btnGhost: { backgroundColor: "transparent" },
  btnGhostText: { color: "#888", fontSize: 14 },
  btnPrimary: { backgroundColor: "#7e6fd0" },
  btnDanger: { backgroundColor: "#e05252" },
  btnPrimaryText: { color: "#fff", fontWeight: "600", fontSize: 14 },

  toastWrap: {
    position: "absolute", left: 0, right: 0, top: 70,
    alignItems: "center",
  },
  toast: {
    paddingHorizontal: 16, paddingVertical: 10,
    borderRadius: 12, borderWidth: 1,
    backgroundColor: "rgba(28,28,42,0.96)",
  },
  toastOk: { borderColor: "rgba(126,111,208,0.45)" },
  toastErr: { borderColor: "rgba(239,68,68,0.45)" },
  toastText: { color: "#fff", fontSize: 13 },

  sheetBg: { flex: 1, backgroundColor: "rgba(8,8,14,0.6)", justifyContent: "flex-end" },
  sheetCard: { padding: 12, gap: 6 },
  sheetTitle: { color: "#888", fontSize: 13, textAlign: "center", paddingVertical: 12, backgroundColor: "#1c1c2a", borderRadius: 14, borderWidth: 1, borderColor: "#2a2a3a" },
  sheetItems: { backgroundColor: "#1c1c2a", borderRadius: 14, borderWidth: 1, borderColor: "#2a2a3a", overflow: "hidden" },
  sheetItem: { height: 50, alignItems: "center", justifyContent: "center" },
  sheetItemBorder: { borderTopWidth: 1, borderTopColor: "#2a2a3a" },
  sheetItemText: { color: "#fff", fontSize: 15, includeFontPadding: false as any, lineHeight: 18 },
  sheetCancel: { backgroundColor: "#1c1c2a", borderRadius: 14, borderWidth: 1, borderColor: "#2a2a3a", height: 50, alignItems: "center", justifyContent: "center", marginTop: 4, marginBottom: 8 },
  sheetCancelText: { color: "#7e6fd0", fontSize: 15, fontWeight: "600", includeFontPadding: false as any, lineHeight: 18 },
});

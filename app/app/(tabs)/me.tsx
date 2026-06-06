import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { ActivityIndicator, Image, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import Constants from "expo-constants";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system/legacy";
import { baseUrl, clientHeaders, loadToken, appVersion } from "@/api/client";
import { api } from "@/api/client";
import { useAuth } from "@/store/auth";
import { confirm, toast, actionSheet } from "@/components/Ui";

export default function Me() {
  const router = useRouter();
  const { username, avatarUrl, logout, setAvatarUrl } = useAuth();
  const [uploading, setUploading] = useState(false);
  const busyRef = useRef(false);

  const onLogout = async () => {
    await logout();
    router.replace("/auth/login");
  };

  const pickAndUpload = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const r = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 0.85,
      });
      if (r.canceled || !r.assets?.[0]) return;
      const asset = r.assets[0];
      setUploading(true);
      const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: "base64" } as any);
      const ct = asset.mimeType || (asset.uri.endsWith(".png") ? "image/png" : "image/jpeg");
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const token = await loadToken();
      const res = await fetch(`${baseUrl}/user/avatar`, {
        method: "POST",
        headers: {
          "Content-Type": ct,
          ...clientHeaders(),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: bytes,
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "上传失败");
      setAvatarUrl(data.avatar_url);
      toast("头像已更新");
    } catch (e: any) {
      toast(e.message || "上传失败", "err");
    } finally {
      setUploading(false);
      busyRef.current = false;
    }
  };

  const removeAvatar = async () => {
    const ok = await confirm({ title: "移除头像", message: "确定移除当前头像？", destructive: true, confirmText: "移除" });
    if (!ok) return;
    try {
      await api("DELETE", "/user/avatar");
      setAvatarUrl(null);
      toast("已移除");
    } catch (e: any) {
      toast(e.message || "操作失败", "err");
    }
  };

  const onAvatarPress = () => {
    if (uploading) return;
    if (avatarUrl) {
      actionSheet("头像", [
        { label: "更换头像", onPress: pickAndUpload },
        { label: "移除头像", destructive: true, onPress: removeAvatar },
      ]);
    } else {
      pickAndUpload();
    }
  };

  const initial = (username || "我")[0];

  return (
    <View style={s.container}>
      <View style={s.header}>
        <Text style={s.title}>我的</Text>
      </View>

      <View style={s.profile}>
        <Pressable style={s.avatarWrap} onPress={onAvatarPress} disabled={uploading}>
          <View style={s.avatar}>
            {avatarUrl
              ? <Image source={{ uri: avatarUrl }} style={s.avatarImg} />
              : <Text style={s.avatarText}>{initial}</Text>}
          </View>
          {uploading ? (
            <View style={s.avatarMask}><ActivityIndicator color="#fff" /></View>
          ) : (
            <View style={s.editBadge}><Text style={s.editBadgeText}>编辑</Text></View>
          )}
        </Pressable>
        <Text style={s.username}>{username || "—"}</Text>
        <Text style={s.hint}>点击头像更换</Text>
      </View>

      <Pressable style={s.btn} onPress={onLogout}>
        <Text style={s.btnText}>退出登录</Text>
      </Pressable>

      <View style={s.aboutCard}>
        <Text style={s.aboutTitle}>应用信息</Text>
        <Text style={s.aboutRow}>版本 {appVersion}{" "}
          <Text style={s.aboutTag}>{Constants.expoConfig?.name || "Tornado"}</Text>
          {"  "}·{"  "}
          <Text style={s.aboutTag}>{Platform.OS} {String(Platform.Version ?? "")}</Text>
        </Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f17", padding: 16, paddingTop: 56 },
  header: { marginBottom: 24 },
  title: { color: "#fff", fontSize: 22, fontWeight: "700" },

  profile: { alignItems: "center", backgroundColor: "#1c1c2a", borderRadius: 12, paddingVertical: 28, marginBottom: 16 },
  avatarWrap: { width: 96, height: 96, marginBottom: 14 },
  avatar: {
    width: 96, height: 96, borderRadius: 48, overflow: "hidden",
    backgroundColor: "rgba(126,111,208,0.18)", alignItems: "center", justifyContent: "center",
  },
  avatarImg: { width: "100%", height: "100%" },
  avatarText: { color: "#fff", fontSize: 36, fontWeight: "600" },
  avatarMask: {
    ...StyleSheet.absoluteFillObject, borderRadius: 48,
    backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center",
  },
  editBadge: {
    position: "absolute", right: -2, bottom: -2,
    backgroundColor: "#7e6fd0", borderRadius: 12, paddingHorizontal: 10, paddingVertical: 3,
    borderWidth: 2, borderColor: "#1c1c2a",
  },
  editBadgeText: { color: "#fff", fontSize: 11, fontWeight: "600" },
  username: { color: "#fff", fontSize: 18, fontWeight: "600" },
  hint: { color: "#888", fontSize: 12, marginTop: 4 },

  btn: { backgroundColor: "#7e6fd0", padding: 14, borderRadius: 10, alignItems: "center", marginTop: 24 },
  btnText: { color: "#fff", fontWeight: "600" },

  aboutCard: { backgroundColor: "#1c1c2a", borderRadius: 10, padding: 14, marginTop: 20 },
  aboutTitle: { color: "#888", fontSize: 12, marginBottom: 6 },
  aboutRow: { color: "#bbb", fontSize: 13 },
  aboutTag: { color: "#eee" },
});

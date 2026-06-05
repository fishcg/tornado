import { useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth } from "@/store/auth";

export default function Me() {
  const router = useRouter();
  const { username, logout } = useAuth();

  const onLogout = async () => {
    await logout();
    router.replace("/auth/login");
  };

  return (
    <View style={s.container}>
      <View style={s.header}>
        <Text style={s.title}>我的</Text>
      </View>
      <View style={s.card}>
        <Text style={s.label}>账号</Text>
        <Text style={s.value}>{username || "—"}</Text>
      </View>

      <Pressable style={s.btn} onPress={onLogout}>
        <Text style={s.btnText}>退出登录</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f17", padding: 16, paddingTop: 56 },
  header: { marginBottom: 24 },
  title: { color: "#fff", fontSize: 22, fontWeight: "700" },
  card: { backgroundColor: "#1c1c2a", padding: 16, borderRadius: 10, marginBottom: 16 },
  label: { color: "#888", fontSize: 12, marginBottom: 6 },
  value: { color: "#fff", fontSize: 16 },
  btn: { backgroundColor: "#7e6fd0", padding: 14, borderRadius: 10, alignItems: "center", marginTop: 24 },
  btnText: { color: "#fff", fontWeight: "600" },
});

import { Link, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useAuth } from "@/store/auth";

export default function Login() {
  const router = useRouter();
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onSubmit = async () => {
    if (!username.trim() || !password) return;
    setBusy(true); setErr(null);
    try {
      await login(username.trim(), password);
      router.replace("/");
    } catch (e: any) {
      setErr(e.message || "登录失败");
    } finally { setBusy(false); }
  };

  return (
    <View style={s.container}>
      <Text style={s.title}>Tornado</Text>
      <Text style={s.subtitle}>登录你的伴侣</Text>
      <TextInput style={s.input} placeholder="用户名" placeholderTextColor="#666"
        autoCapitalize="none" value={username} onChangeText={setUsername} />
      <TextInput style={s.input} placeholder="密码" placeholderTextColor="#666"
        secureTextEntry value={password} onChangeText={setPassword} />
      {err && <Text style={s.err}>{err}</Text>}
      <Pressable style={[s.btn, busy && { opacity: 0.5 }]} disabled={busy} onPress={onSubmit}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>登录</Text>}
      </Pressable>
      <Link href="/auth/register" style={s.link}>没有账号？去注册</Link>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, padding: 24, justifyContent: "center", backgroundColor: "#0f0f17" },
  title: { fontSize: 36, color: "#fff", fontWeight: "700", marginBottom: 4 },
  subtitle: { fontSize: 14, color: "#999", marginBottom: 32 },
  input: { backgroundColor: "#1c1c2a", color: "#fff", padding: 14, borderRadius: 10, marginBottom: 12, borderWidth: 1, borderColor: "#2a2a3a" },
  btn: { backgroundColor: "#7e6fd0", padding: 14, borderRadius: 10, alignItems: "center", marginTop: 8 },
  btnText: { color: "#fff", fontWeight: "600", fontSize: 16 },
  link: { color: "#7e6fd0", textAlign: "center", marginTop: 20 },
  err: { color: "#f87171", marginBottom: 8 },
});

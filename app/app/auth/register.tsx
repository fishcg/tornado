import { Link, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useAuth } from "@/store/auth";

export default function Register() {
  const router = useRouter();
  const { register } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onSubmit = async () => {
    if (!username.trim() || !password) return;
    setBusy(true); setErr(null);
    try {
      await register(username.trim(), password, invite.trim() || undefined);
      router.replace("/");
    } catch (e: any) {
      setErr(e.message || "注册失败");
    } finally { setBusy(false); }
  };

  return (
    <View style={s.container}>
      <Text style={s.title}>注册</Text>
      <TextInput style={s.input} placeholder="用户名" placeholderTextColor="#666"
        autoCapitalize="none" value={username} onChangeText={setUsername} />
      <TextInput style={s.input} placeholder="密码" placeholderTextColor="#666"
        secureTextEntry value={password} onChangeText={setPassword} />
      <TextInput style={s.input} placeholder="邀请码（可选）" placeholderTextColor="#666"
        autoCapitalize="none" value={invite} onChangeText={setInvite} />
      {err && <Text style={s.err}>{err}</Text>}
      <Pressable style={[s.btn, busy && { opacity: 0.5 }]} disabled={busy} onPress={onSubmit}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>注册</Text>}
      </Pressable>
      <Link href="/auth/login" style={s.link}>已有账号？去登录</Link>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, padding: 24, justifyContent: "center", backgroundColor: "#0f0f17" },
  title: { fontSize: 36, color: "#fff", fontWeight: "700", marginBottom: 32 },
  input: { backgroundColor: "#1c1c2a", color: "#fff", padding: 14, borderRadius: 10, marginBottom: 12, borderWidth: 1, borderColor: "#2a2a3a" },
  btn: { backgroundColor: "#7e6fd0", padding: 14, borderRadius: 10, alignItems: "center", marginTop: 8 },
  btnText: { color: "#fff", fontWeight: "600", fontSize: 16 },
  link: { color: "#7e6fd0", textAlign: "center", marginTop: 20 },
  err: { color: "#f87171", marginBottom: 8 },
});

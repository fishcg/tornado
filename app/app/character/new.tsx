import { useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable,
  ScrollView, StyleSheet, Switch, Text, TextInput, View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system/legacy";
import { api, baseUrl, clientHeaders, loadToken } from "@/api/client";
import PageHeader from "@/components/PageHeader";
import { toast } from "@/components/Ui";

export default function NewCharacter() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [appearance, setAppearance] = useState("");
  const [description, setDescription] = useState("");
  const [personality, setPersonality] = useState("");
  const [soul, setSoul] = useState("");
  const [activate, setActivate] = useState(true);
  const [refImage, setRefImage] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [busy, setBusy] = useState(false);

  const pickRefImage = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"], allowsEditing: true, aspect: [2, 3], quality: 0.85,
    });
    if (r.canceled || !r.assets?.[0]) return;
    setRefImage(r.assets[0]);
  };

  // 把已选参考图上传到指定角色（图生图基准）；失败抛错由上层处理
  const uploadRefImage = async (charId: number, asset: ImagePicker.ImagePickerAsset) => {
    const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: "base64" } as any);
    const ct = asset.mimeType || (asset.uri.endsWith(".png") ? "image/png" : "image/jpeg");
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const token = await loadToken();
    const res = await fetch(`${baseUrl}/characters/${charId}/reference-image`, {
      method: "POST",
      headers: {
        "Content-Type": ct,
        ...clientHeaders(),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: bytes,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "参考图上传失败");
  };

  const submit = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    try {
      const r = await api<{ id: number }>("POST", "/characters", { name: n, soul_content: soul });
      // 有参考图先上传，确保随后激活时的卡片/头像生成走图生图
      if (refImage) {
        try {
          await uploadRefImage(r.id, refImage);
        } catch (e: any) {
          toast(e.message || "参考图上传失败，将使用文字生成形象", "err");
        }
      }
      // 第二步：把结构化字段一起补上
      await api("PATCH", `/characters/${r.id}`, {
        appearance, description, personality,
        ...(activate ? { is_active: true } : {}),
      });
      router.back();
    } catch (e: any) {
      if (e?.status === 402) {
        toast("小鱼干不足，去【我的】签到获取", "err");
      } else {
        toast(e.message || "创建失败", "err");
      }
    } finally { setBusy(false); }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={s.container}>
      <PageHeader title="新建角色" />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>

        <Text style={s.label}>名字</Text>
        <TextInput value={name} onChangeText={setName} style={s.input} placeholder="比如：龙卷"
          placeholderTextColor="#555" />

        <Text style={s.label}>外貌</Text>
        <Text style={s.hint}>用于生成图片，长相 / 发型 / 服饰 / 体态等</Text>
        <TextInput value={appearance} onChangeText={setAppearance} style={[s.input, s.area2]}
          multiline placeholderTextColor="#555" />

        <Text style={s.label}>参考图（可选）</Text>
        <Text style={s.hint}>上传后，角色卡片、头像及聊天配图都会以此图做图生图，保持形象统一</Text>
        <View style={s.refRow}>
          <Pressable style={s.refPicker} onPress={pickRefImage}>
            {refImage ? (
              <Image source={{ uri: refImage.uri }} style={s.refImg} />
            ) : (
              <Text style={s.refPlus}>＋</Text>
            )}
          </Pressable>
          {refImage && (
            <Pressable style={s.refRemove} onPress={() => setRefImage(null)}>
              <Text style={s.refRemoveText}>移除</Text>
            </Pressable>
          )}
        </View>

        <Text style={s.label}>背景说明</Text>
        <Text style={s.hint}>角色来源、身份、世界观背景</Text>
        <TextInput value={description} onChangeText={setDescription} style={[s.input, s.area2]}
          multiline placeholderTextColor="#555" />

        <Text style={s.label}>性格</Text>
        <Text style={s.hint}>性格特征、口头禅、对待你的方式</Text>
        <TextInput value={personality} onChangeText={setPersonality} style={[s.input, s.area3]}
          multiline placeholderTextColor="#555" />

        <Text style={s.label}>Soul（高级）</Text>
        <Text style={s.hint}>留空将基于上面的字段自动生成；填写后将作为完整 prompt 注入</Text>
        <TextInput value={soul} onChangeText={setSoul} style={[s.input, s.areaBig]}
          multiline placeholderTextColor="#555" />

        <View style={s.toggleRow}>
          <Text style={{ color: "#ddd" }}>创建后立即激活</Text>
          <Switch
            value={activate}
            onValueChange={setActivate}
            trackColor={{ false: "#333", true: "#7e6fd0" }}
            thumbColor={activate ? "#f3f0ff" : "#bbb"}
            ios_backgroundColor="#333"
          />
        </View>

        <Pressable style={[s.submit, (!name.trim() || busy) && { opacity: 0.4 }]}
          onPress={submit} disabled={!name.trim() || busy}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.submitText}>创建</Text>}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f17" },
  back: { color: "#7e6fd0", marginBottom: 12 },
  title: { color: "#fff", fontSize: 22, fontWeight: "700", marginBottom: 18 },
  label: { color: "#ddd", fontSize: 13, marginBottom: 4, marginTop: 16 },
  hint: { color: "#666", fontSize: 11, marginBottom: 6, lineHeight: 16 },
  input: { backgroundColor: "#1c1c2a", color: "#fff", padding: 12, borderRadius: 10, borderWidth: 1, borderColor: "#2a2a3a" },
  area2: { minHeight: 60, textAlignVertical: "top" },
  area3: { minHeight: 90, textAlignVertical: "top" },
  areaBig: { minHeight: 150, textAlignVertical: "top" },
  refRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  refPicker: { width: 96, height: 128, borderRadius: 10, backgroundColor: "#1c1c2a", borderWidth: 1, borderColor: "#2a2a3a", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  refImg: { width: "100%", height: "100%" },
  refPlus: { color: "#555", fontSize: 32, fontWeight: "300" },
  refRemove: { paddingHorizontal: 12, paddingVertical: 8 },
  refRemoveText: { color: "#c0607a", fontSize: 13 },
  toggleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 18 },
  submit: { backgroundColor: "#7e6fd0", padding: 14, borderRadius: 10, alignItems: "center", marginTop: 24 },
  submitText: { color: "#fff", fontWeight: "600", fontSize: 16 },
});

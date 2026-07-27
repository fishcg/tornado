import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import { api } from "@/api/client";
import PageHeader from "@/components/PageHeader";
import { confirm, toast, hapticLight } from "@/components/Ui";

type CharDetail = {
  id: number;
  name: string;
  appearance: string | null;
  personality: string | null;
  description: string | null;
  values_content: string | null;
  boundaries_content: string | null;
  habits_content: string | null;
  speech_examples: string | null;
  soul_content: string | null;
  is_active: number;
};

export default function EditCharacter() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const cid = Number(id);
  const [name, setName] = useState("");
  const [appearance, setAppearance] = useState("");
  const [description, setDescription] = useState("");
  const [personality, setPersonality] = useState("");
  const [valuesContent, setValuesContent] = useState("");
  const [boundariesContent, setBoundariesContent] = useState("");
  const [habitsContent, setHabitsContent] = useState("");
  const [speechExamples, setSpeechExamples] = useState("");
  const [soul, setSoul] = useState("");
  const [isActive, setIsActive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<CharDetail>("GET", `/characters/${cid}`)
      .then((d) => {
        setName(d.name || "");
        setAppearance(d.appearance || "");
        setDescription(d.description || "");
        setPersonality(d.personality || "");
        setValuesContent(d.values_content || "");
        setBoundariesContent(d.boundaries_content || "");
        setHabitsContent(d.habits_content || "");
        setSpeechExamples(d.speech_examples || "");
        setSoul(d.soul_content || "");
        setIsActive(!!d.is_active);
      })
      .catch((e) => toast(e.message || "加载失败", "err"))
      .finally(() => setLoading(false));
  }, [cid]);

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api("PATCH", `/characters/${cid}`, {
        name: name.trim(),
        appearance, description, personality,
        values_content: valuesContent,
        boundaries_content: boundariesContent,
        habits_content: habitsContent,
        speech_examples: speechExamples,
        soul_content: soul,
      });
      router.back();
    } catch (e: any) {
      toast(e.message || "保存失败", "err");
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (isActive) { toast("无法删除当前激活的角色", "err"); return; }
    const ok = await confirm({
      title: "确认删除",
      message: `删除「${name}」后无法恢复`,
      confirmText: "删除",
      destructive: true,
    });
    if (!ok) return;
    try { await api("DELETE", `/characters/${cid}`); hapticLight(); router.back(); }
    catch (e: any) { toast(e.message || "删除失败", "err"); }
  };

  if (loading) return <View style={s.center}><ActivityIndicator color="#7e6fd0" /></View>;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={s.container}>
      <PageHeader title="编辑角色" right={isActive ? <Text style={s.activeTag}>激活中</Text> : null} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <Text style={s.label}>名字</Text>
        <TextInput value={name} onChangeText={setName} style={s.input} placeholderTextColor="#555" />

        <Text style={s.label}>外貌</Text>
        <Text style={s.hint}>用于生成图片，长相 / 发型 / 服饰 / 体态等</Text>
        <TextInput value={appearance} onChangeText={setAppearance} style={[s.input, s.area2]}
          multiline placeholder="外貌描述，用于生成图片" placeholderTextColor="#555" />

        <Text style={s.label}>背景说明</Text>
        <Text style={s.hint}>角色来源、身份、世界观背景</Text>
        <TextInput value={description} onChangeText={setDescription} style={[s.input, s.area2]}
          multiline placeholder="角色来源、背景说明" placeholderTextColor="#555" />

        <Text style={s.label}>性格</Text>
        <Text style={s.hint}>性格特征、口头禅、对待你的方式</Text>
        <TextInput value={personality} onChangeText={setPersonality} style={[s.input, s.area3]}
          multiline placeholder="性格特征" placeholderTextColor="#555" />

        <Text style={s.label}>价值观与在意的事</Text>
        <Text style={s.hint}>她真正重视什么，遇到冲突时如何取舍</Text>
        <TextInput value={valuesContent} onChangeText={setValuesContent} style={[s.input, s.area2]}
          multiline placeholderTextColor="#555" />

        <Text style={s.label}>边界与雷区</Text>
        <Text style={s.hint}>能接受什么，哪些行为会让她不舒服</Text>
        <TextInput value={boundariesContent} onChangeText={setBoundariesContent} style={[s.input, s.area2]}
          multiline placeholderTextColor="#555" />

        <Text style={s.label}>习惯与生活细节</Text>
        <Text style={s.hint}>作息、爱好、小动作和日常习惯</Text>
        <TextInput value={habitsContent} onChangeText={setHabitsContent} style={[s.input, s.area2]}
          multiline placeholderTextColor="#555" />

        <Text style={s.label}>说话示例与反例</Text>
        <Text style={s.hint}>写几组她会怎么说，以及绝不会怎么说</Text>
        <TextInput value={speechExamples} onChangeText={setSpeechExamples} style={[s.input, s.areaBig]}
          multiline placeholderTextColor="#555" />

        <Text style={s.label}>Soul（高级）</Text>
        <Text style={s.hint}>填写后将作为完整 prompt 注入；留空时基于上面字段自动拼装</Text>
        <TextInput value={soul} onChangeText={setSoul} style={[s.input, s.areaBig]}
          multiline placeholderTextColor="#555" />

        <Pressable style={[s.submit, (!name.trim() || busy) && { opacity: 0.4 }]}
          onPress={save} disabled={!name.trim() || busy}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.submitText}>保存</Text>}
        </Pressable>

        <Pressable style={s.deleteBtn} onPress={remove}>
          <Text style={s.deleteText}>删除角色</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f17" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0f0f17" },
  back: { color: "#7e6fd0", marginBottom: 12 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 18 },
  title: { color: "#fff", fontSize: 22, fontWeight: "700" },
  activeTag: { color: "#7e6fd0", fontSize: 12, borderWidth: 1, borderColor: "#7e6fd0", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  label: { color: "#ddd", fontSize: 13, marginBottom: 4, marginTop: 16 },
  hint: { color: "#666", fontSize: 11, marginBottom: 6, lineHeight: 16 },
  input: { backgroundColor: "#1c1c2a", color: "#fff", padding: 12, borderRadius: 10, borderWidth: 1, borderColor: "#2a2a3a" },
  area2: { minHeight: 60, textAlignVertical: "top" },
  area3: { minHeight: 90, textAlignVertical: "top" },
  areaBig: { minHeight: 150, textAlignVertical: "top" },
  submit: { backgroundColor: "#7e6fd0", padding: 14, borderRadius: 10, alignItems: "center", marginTop: 24 },
  submitText: { color: "#fff", fontWeight: "600", fontSize: 16 },
  deleteBtn: { padding: 12, alignItems: "center", marginTop: 14 },
  deleteText: { color: "#ef4444", fontSize: 14 },
});

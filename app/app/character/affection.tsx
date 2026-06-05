import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator, FlatList, Image, RefreshControl, StyleSheet, Text, View,
} from "react-native";
import { api } from "@/api/client";
import { moodInfo } from "@/constants/mood";
import PageHeader from "@/components/PageHeader";
import { useAvatars } from "@/store/avatars";

type Row = {
  delta: number;
  value: number;
  mood: string | null;
  reason: string | null;
  created_at: string;
};

type Character = { id: number; name: string; affection: number };

function fmtDate(iso: string) {
  const d = new Date(iso);
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  const hh = `${d.getHours()}`.padStart(2, "0");
  const mm = `${d.getMinutes()}`.padStart(2, "0");
  return `${m}-${day} ${hh}:${mm}`;
}

export default function CharacterAffection() {
  const [rows, setRows] = useState<Row[]>([]);
  const [character, setCharacter] = useState<Character | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const loadAvatars = useAvatars((s) => s.load);
  const pickAvatar = useAvatars((s) => s.pick);

  useEffect(() => {
    if (character?.name) loadAvatars(character.name);
  }, [character?.name, loadAvatars]);

  const load = useCallback(async () => {
    try {
      const [logs, char] = await Promise.all([
        api<Row[]>("GET", "/character/affection-log"),
        api<Character>("GET", "/character").catch(() => null),
      ]);
      setRows(logs); setCharacter(char);
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (loading) return <View style={s.center}><ActivityIndicator color="#7e6fd0" /></View>;

  return (
    <View style={s.container}>
      <PageHeader title="心动历程" />
      {character && (
        <View style={s.subHeader}>
          <Text style={s.charName}>{character.name}</Text>
          <View style={s.heartBox}>
            <Text style={s.heart}>♥</Text>
            <Text style={s.affValue}>{character.affection}</Text>
          </View>
        </View>
      )}
      <FlatList
        data={rows}
        keyExtractor={(_, i) => `${i}`}
        contentContainerStyle={{ padding: 12 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor="#7e6fd0" />}
        ListEmptyComponent={<Text style={s.empty}>还没有心动值变化</Text>}
        renderItem={({ item }) => {
          const m = moodInfo(item.mood);
          const sign = item.delta > 0 ? "+" : "";
          const dColor = item.delta > 0 ? "#22c55e" : item.delta < 0 ? "#ef4444" : "#777";
          const avatar = character?.name ? pickAvatar(character.name, item.mood || "neutral") : null;
          return (
            <View style={s.row}>
              <View style={[s.moodChip, { borderColor: m.color }]}>
                {avatar
                  ? <Image source={{ uri: avatar }} style={s.moodChipImg} />
                  : <Text style={s.moodEmoji}>{m.emoji}</Text>}
              </View>
              <Text style={[s.delta, { color: dColor }]}>{sign}{item.delta}</Text>
              <View style={{ flex: 1 }}>
                <Text style={s.reason}>{item.reason || "—"}</Text>
                <Text style={s.meta}>心动值 {item.value} · {m.label} · {fmtDate(item.created_at)}</Text>
              </View>
            </View>
          );
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f17" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0f0f17" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  back: { color: "#7e6fd0", fontSize: 15 },
  title: { color: "#fff", fontSize: 18, fontWeight: "700" },
  subHeader: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingBottom: 8 },
  charName: { color: "#bbb", fontSize: 14 },
  heartBox: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "#1c1c2a", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  heart: { color: "#f472b6", fontSize: 13 },
  affValue: { color: "#fff", fontSize: 13, fontWeight: "600" },
  empty: { color: "#666", textAlign: "center", marginTop: 60 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderRadius: 10, backgroundColor: "#1c1c2a", marginBottom: 8 },
  moodChip: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", borderWidth: 1, overflow: "hidden", backgroundColor: "#1c1c2a" },
  moodChipImg: { width: "100%", height: "100%" },
  moodEmoji: { fontSize: 18 },
  delta: { fontSize: 16, fontWeight: "700", width: 40, textAlign: "center" },
  reason: { color: "#ddd", fontSize: 14 },
  meta: { color: "#777", fontSize: 11, marginTop: 3 },
});

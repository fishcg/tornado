import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View,
} from "react-native";
import PageHeader from "@/components/PageHeader";
import { useAnnouncements } from "@/store/announcements";

export default function AnnouncementsScreen() {
  const { list, unreadCount, loadList, markRead, markAllRead } = useAnnouncements();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = useCallback(async () => {
    await loadList();
    setLoading(false);
    setRefreshing(false);
  }, [loadList]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onTap = (id: number, isRead?: boolean) => {
    setExpanded((cur) => (cur === id ? null : id));
    if (!isRead) markRead(id);
  };

  if (loading) return <View style={s.center}><ActivityIndicator color="#7e6fd0" /></View>;

  return (
    <View style={s.container}>
      <PageHeader
        title="系统通知"
        right={
          unreadCount > 0 ? (
            <Pressable onPress={markAllRead} hitSlop={8} style={{ paddingHorizontal: 8 }}>
              <Text style={s.headerAction}>全部已读</Text>
            </Pressable>
          ) : null
        }
      />
      <FlatList
        data={list}
        keyExtractor={(it) => String(it.id)}
        contentContainerStyle={{ padding: 12, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor="#7e6fd0" />}
        ListEmptyComponent={<Text style={s.empty}>暂无系统通知</Text>}
        renderItem={({ item }) => {
          const isExpanded = expanded === item.id;
          return (
            <Pressable style={s.card} onPress={() => onTap(item.id, item.is_read)}>
              <View style={s.titleRow}>
                {!item.is_read ? <View style={s.dot} /> : null}
                <Text style={[s.title, !item.is_read && { fontWeight: "700" }]} numberOfLines={isExpanded ? undefined : 1}>
                  {item.title}
                </Text>
              </View>
              <Text style={s.date}>{new Date(item.created_at).toLocaleString("zh-CN")}</Text>
              <Text style={s.body} numberOfLines={isExpanded ? undefined : 2}>{item.content}</Text>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f17" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0f0f17" },
  empty: { color: "#666", textAlign: "center", marginTop: 60 },
  headerAction: { color: "#7e6fd0", fontSize: 14 },
  card: { backgroundColor: "#1c1c2a", borderRadius: 10, padding: 14, marginBottom: 10 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#ef4444" },
  title: { color: "#fff", fontSize: 15, flex: 1 },
  date: { color: "#666", fontSize: 12, marginTop: 4 },
  body: { color: "#bbb", fontSize: 14, lineHeight: 21, marginTop: 8 },
});

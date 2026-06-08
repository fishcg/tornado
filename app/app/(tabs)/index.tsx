import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, Animated, Easing, FlatList, Image, LayoutAnimation, Platform,
  Pressable, RefreshControl, StyleSheet, Text, UIManager, View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Swipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import { api } from "@/api/client";
import { confirm, toast, hapticLight } from "@/components/Ui";
import { IconBookmark } from "@/components/Icons";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

type Session = {
  id: number;
  title: string;
  last_message?: string | null;
  topic_summary?: string | null;
  character_name?: string | null;
  character_avatar?: string | null;
  updated_at: string;
};

type Group = {
  characterName: string;
  avatar: string | null;
  sessions: Session[];
};

type Character = { id: number; name: string; is_active: number };

const UNGROUPED_KEY = "（未指派角色）";

export default function SessionsList() {
  const router = useRouter();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const swipeRefs = useRef<Map<number, Swipeable>>(new Map());

  const load = useCallback(async () => {
    try {
      const [list, active, chars] = await Promise.all([
        api<Session[]>("GET", "/sessions"),
        api<{ name: string }>("GET", "/character").catch(() => null),
        api<Character[]>("GET", "/characters").catch(() => []),
      ]);
      setSessions(list);
      setCharacters(chars || []);
      setActiveName(active?.name || null);
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // 分组：按角色名聚合，激活角色组排第一
  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>();
    for (const sess of sessions) {
      const name = sess.character_name || UNGROUPED_KEY;
      const g = map.get(name) || { characterName: name, avatar: sess.character_avatar || null, sessions: [] };
      if (!g.avatar && sess.character_avatar) g.avatar = sess.character_avatar;
      g.sessions.push(sess);
      map.set(name, g);
    }
    const arr = Array.from(map.values());
    arr.sort((a, b) => {
      if (a.characterName === activeName) return -1;
      if (b.characterName === activeName) return 1;
      return 0;
    });
    return arr;
  }, [sessions, activeName]);

  // 默认折叠状态：激活组展开，其他折叠（仅初始化一次）
  const initedRef = useRef(false);
  if (!initedRef.current && groups.length > 0) {
    initedRef.current = true;
    const init: Record<string, boolean> = {};
    for (const g of groups) {
      init[g.characterName] = g.characterName !== activeName;
    }
    if (Object.keys(collapsed).length === 0) {
      setCollapsed(init);
    }
  }

  const toggleGroup = (name: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setCollapsed((c) => ({ ...c, [name]: !c[name] }));
  };

  const newSession = async () => {
    const s = await api<Session>("POST", "/sessions", { title: "新对话" });
    router.push(`/chat/${s.id}`);
  };

  // 打开会话前先把对应角色激活，避免 A 角色会话变成 B 角色
  const openSession = async (sess: Session) => {
    const charName = sess.character_name;
    if (charName && charName !== activeName) {
      const target = characters.find((c) => c.name === charName);
      if (target) {
        try { await api("PATCH", `/characters/${target.id}`, { is_active: true }); }
        catch {}
        setActiveName(charName);
      }
    }
    router.push(`/chat/${sess.id}`);
  };

  const closeSwipe = (id: number) => {
    const ref = swipeRefs.current.get(id);
    ref?.close?.();
  };

  const onIngest = async (id: number) => {
    closeSwipe(id);
    try {
      await api("POST", `/sessions/${id}/ingest`);
      toast("已存入记忆库");
    } catch (e: any) {
      toast(e.message || "存入失败", "err");
    }
  };

  const onDelete = async (id: number) => {
    const ok = await confirm({
      title: "删除会话",
      message: "删除后将不再出现在列表（数据保留可恢复）",
      confirmText: "删除",
      destructive: true,
    });
    if (!ok) { closeSwipe(id); return; }
    try {
      await api("DELETE", `/sessions/${id}`);
      hapticLight();
      setSessions((arr) => arr.filter((x) => x.id !== id));
      toast("已删除");
    } catch (e: any) {
      toast(e.message || "删除失败", "err");
      closeSwipe(id);
    }
  };

  const renderRightActions = (id: number) => () => (
    <View style={s.rightActions}>
      <Pressable style={[s.action, s.actionIngest]} onPress={() => onIngest(id)}>
        <IconBookmark size={20} color="#fff" />
        <Text style={s.actionText}>存记忆</Text>
      </Pressable>
      <Pressable style={[s.action, s.actionDelete]} onPress={() => onDelete(id)}>
        <Text style={s.actionTextLg}>×</Text>
        <Text style={s.actionText}>删除</Text>
      </Pressable>
    </View>
  );

  if (loading) {
    return <View style={s.center}><ActivityIndicator color="#7e6fd0" /></View>;
  }

  return (
    <View style={s.container}>
      <SafeAreaView edges={["top"]} style={s.safe}>
        <View style={s.header}>
          <Text style={s.headerTitle}>会话</Text>
          <Pressable style={s.newBtn} onPress={newSession}>
            <Text style={s.newBtnText}>＋ 新对话</Text>
          </Pressable>
        </View>
      </SafeAreaView>

      <FlatList
        data={groups}
        keyExtractor={(g) => g.characterName}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor="#7e6fd0" />}
        ListEmptyComponent={<Text style={s.empty}>还没有会话，点右上"新对话"开聊吧</Text>}
        renderItem={({ item: group }) => {
          const isCollapsed = !!collapsed[group.characterName];
          const isActive = group.characterName === activeName;
          const initial = group.characterName?.[0] || "?";
          return (
            <View>
              <Pressable
                style={[s.groupHeader, isActive && s.groupHeaderActive]}
                onPress={() => toggleGroup(group.characterName)}
              >
                <View style={s.groupAvatar}>
                  {group.avatar ? (
                    <Image source={{ uri: group.avatar }} style={s.groupAvatarImg} />
                  ) : (
                    <Text style={s.groupAvatarText}>{initial}</Text>
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.groupName} numberOfLines={1}>
                    {group.characterName}
                    {isActive ? <Text style={s.activeTag}>  · 激活中</Text> : null}
                  </Text>
                  <Text style={s.groupCount}>{group.sessions.length} 个会话</Text>
                </View>
                <Text style={[s.chevron, !isCollapsed && s.chevronOpen]}>›</Text>
              </Pressable>

              {!isCollapsed && group.sessions.map((item) => {
                const subtitle = item.topic_summary || item.last_message || "";
                return (
                  <Swipeable
                    key={item.id}
                    ref={(r) => {
                      if (r) swipeRefs.current.set(item.id, r as any);
                      else swipeRefs.current.delete(item.id);
                    }}
                    renderRightActions={renderRightActions(item.id)}
                    friction={1.6}
                    rightThreshold={30}
                    overshootRight={false}
                    containerStyle={s.swipeContainer}
                  >
                    <Pressable style={s.row} onPress={() => openSession(item)}>
                      <View style={s.itemDot} />
                      <View style={{ flex: 1 }}>
                        <Text style={s.title} numberOfLines={1}>{item.title || "（未命名）"}</Text>
                        {subtitle ? <Text style={s.preview} numberOfLines={2}>{subtitle}</Text> : null}
                      </View>
                    </Pressable>
                  </Swipeable>
                );
              })}
            </View>
          );
        }}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f17" },
  center: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#0f0f17" },
  safe: { backgroundColor: "#0f0f17" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12 },
  headerTitle: { color: "#fff", fontSize: 22, fontWeight: "700" },
  newBtn: { backgroundColor: "#7e6fd0", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  newBtnText: { color: "#fff", fontWeight: "600" },

  groupHeader: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: "#1c1c2a",
    borderTopWidth: 1, borderTopColor: "#0f0f17",
  },
  groupHeaderActive: {
    borderLeftWidth: 3, borderLeftColor: "#7e6fd0",
    paddingLeft: 13,
  },
  groupAvatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: "rgba(126,111,208,0.18)", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  groupAvatarImg: { width: "100%", height: "100%" },
  groupAvatarText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  groupName: { color: "#fff", fontSize: 15, fontWeight: "600" },
  groupCount: { color: "#888", fontSize: 12, marginTop: 2 },
  activeTag: { color: "#7e6fd0", fontSize: 12, fontWeight: "500" },
  chevron: {
    color: "#888", fontSize: 24, fontWeight: "300",
    transform: [{ rotate: "90deg" }],
  },
  chevronOpen: {
    transform: [{ rotate: "270deg" }],
  },

  swipeContainer: { backgroundColor: "#0f0f17" },
  row: {
    flexDirection: "row", alignItems: "center", gap: 14,
    paddingHorizontal: 22, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: "#1c1c2a",
    backgroundColor: "#0f0f17",
  },
  itemDot: {
    width: 6, height: 6, borderRadius: 3,
    backgroundColor: "#3a3560",
  },
  title: { color: "#fff", fontSize: 15, fontWeight: "500" },
  preview: { color: "#777", fontSize: 12, marginTop: 3, lineHeight: 17 },
  empty: { color: "#666", textAlign: "center", marginTop: 60 },

  rightActions: { flexDirection: "row" },
  action: { width: 76, alignItems: "center", justifyContent: "center", gap: 4 },
  actionIngest: { backgroundColor: "#7e6fd0" },
  actionDelete: { backgroundColor: "#e05252" },
  actionText: { color: "#fff", fontSize: 12, fontWeight: "600" },
  actionTextLg: { color: "#fff", fontSize: 26, lineHeight: 28, fontWeight: "300" },
});

import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Dimensions, FlatList, Image, ImageBackground, Modal, Pressable,
  RefreshControl, ScrollView, StyleSheet, Text, View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { SafeAreaView } from "react-native-safe-area-context";
import * as MediaLibrary from "expo-media-library";
import * as FileSystem from "expo-file-system/legacy";
import { api } from "@/api/client";
import { IconHeart, IconGallery, IconSparkle, IconTrophy, IconPhone, IconImage, IconBack } from "@/components/Icons";
import { confirm, toast, actionSheet } from "@/components/Ui";

type Character = { id: number; name: string; is_active: number; created_at: string; avatar_url?: string | null };
type ActiveDetail = { id: number; name: string; affection: number; card_url: string | null };
type Card = { id: number; image_url: string; is_active: number; created_at: string };

const HERO_HEIGHT = Math.round(Dimensions.get("window").height / 3);

export default function CharacterTab() {
  const router = useRouter();
  const [list, setList] = useState<Character[]>([]);
  const [active, setActive] = useState<ActiveDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [switching, setSwitching] = useState<number | null>(null);
  const [cardsOpen, setCardsOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [chars, act] = await Promise.all([
        api<Character[]>("GET", "/characters"),
        api<ActiveDetail>("GET", "/character").catch(() => null),
      ]);
      // 激活角色排到第一位
      const sorted = [...chars].sort((a, b) => Number(b.is_active) - Number(a.is_active));
      setList(sorted);
      setActive(act);
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const activate = async (id: number) => {
    if (switching || active?.id === id) return;
    setSwitching(id);
    try {
      await api("PATCH", `/characters/${id}`, { is_active: true });
      await load();
    } catch (e: any) {
      toast(e.message || "切换失败", "err");
    } finally { setSwitching(null); }
  };

  if (loading) return <View style={s.center}><ActivityIndicator color="#7e6fd0" /></View>;

  const heroUri = active?.card_url || null;

  return (
    <>
      <ScrollView
        style={s.container}
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor="#7e6fd0" />}
      >
        <View style={[s.hero, { height: HERO_HEIGHT }]}>
          {heroUri ? (
            <ImageBackground source={{ uri: heroUri }} style={s.heroImg} resizeMode="cover">
              <LinearGradient
                colors={["transparent", "rgba(15,15,23,0.4)", "#0f0f17"]}
                locations={[0.4, 0.75, 1]}
                style={StyleSheet.absoluteFill}
              />
            </ImageBackground>
          ) : (
            <LinearGradient
              colors={["#2a1a35", "#1c1c2a", "#0f0f17"]}
              style={StyleSheet.absoluteFill}
            />
          )}
          {active ? (
            <SafeAreaView edges={["top"]} style={s.heroTopBar}>
              <Pressable
                style={s.cardsBtn}
                hitSlop={8}
                onPress={() => setCardsOpen(true)}
              >
                <IconImage size={20} color="#fff" />
              </Pressable>
            </SafeAreaView>
          ) : null}
          <View style={s.heroContent}>
            {active ? (
              <>
                <Text style={s.heroName}>{active.name}</Text>
                <View style={s.heartRow}>
                  <Text style={s.heart}>♥</Text>
                  <Text style={s.affValue}>{active.affection}</Text>
                </View>
              </>
            ) : (
              <Text style={s.heroEmpty}>还没有激活的角色</Text>
            )}
          </View>
        </View>

        {active && (
          <View style={s.body}>
            <View style={s.entryGrid}>
              <Pressable style={s.entry} onPress={() => router.push("/character/affection")}>
                <View style={s.entryIconWrap}><IconHeart size={22} color="#f472b6" /></View>
                <Text style={s.entryLabel}>心动</Text>
              </Pressable>
              <Pressable style={s.entry} onPress={() => router.push("/character/gallery")}>
                <View style={s.entryIconWrap}><IconGallery size={22} color="#7e6fd0" /></View>
                <Text style={s.entryLabel}>画廊</Text>
              </Pressable>
              <Pressable style={s.entry} onPress={() => router.push("/character/milestones")}>
                <View style={s.entryIconWrap}><IconSparkle size={22} color="#7e6fd0" /></View>
                <Text style={s.entryLabel}>里程碑</Text>
              </Pressable>
              <Pressable style={s.entry} onPress={() => router.push("/achievements")}>
                <View style={s.entryIconWrap}><IconTrophy size={22} color="#7e6fd0" /></View>
                <Text style={s.entryLabel}>成就</Text>
              </Pressable>
              <Pressable style={s.entry} onPress={() => router.push("/character/calls")}>
                <View style={s.entryIconWrap}><IconPhone size={22} color="#7e6fd0" /></View>
                <Text style={s.entryLabel}>来电</Text>
              </Pressable>
            </View>

            <View style={s.editRow}>
              <Pressable style={[s.editBtn, { flex: 1 }]} onPress={() => router.push(`/character/edit/${active.id}`)}>
                <Text style={s.editText}>编辑角色</Text>
              </Pressable>
              <Pressable style={[s.editBtn, { flex: 1 }]} onPress={() => router.push("/character/voice")}>
                <Text style={s.editText}>声音复刻</Text>
              </Pressable>
            </View>
          </View>
        )}

        <View style={s.section}>
          <Text style={s.sectionTitle}>所有角色</Text>
          {list.length === 0 ? (
            <Text style={s.empty}>暂无角色</Text>
          ) : (
            list.map((c) => (
              <Pressable key={c.id} style={[s.row, c.is_active ? s.rowActive : null]}
                onPress={() => activate(c.id)}>
                <View style={[s.avatarSm, !c.avatar_url && { backgroundColor: c.is_active ? "#7e6fd0" : "#2a2a3a" }]}>
                  {c.avatar_url ? (
                    <Image source={{ uri: c.avatar_url }} style={s.avatarSmImg} />
                  ) : (
                    <Text style={s.avatarSmText}>{c.name?.[0] || "?"}</Text>
                  )}
                </View>
                <Text style={s.rowName}>{c.name}</Text>
                {c.is_active ? (
                  <Text style={s.activeTag}>激活中</Text>
                ) : switching === c.id ? (
                  <ActivityIndicator color="#7e6fd0" />
                ) : (
                  <Text style={s.switchHint}>切换</Text>
                )}
              </Pressable>
            ))
          )}

          <View style={s.newWrap}>
            <Pressable style={s.newBtn} onPress={() => router.push("/character/new")}>
              <Text style={s.newBtnText}>＋ 新建角色</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>

      <CardsModal
        visible={cardsOpen}
        onClose={() => setCardsOpen(false)}
        onChanged={load}
      />
    </>
  );
}

function CardsModal({ visible, onClose, onChanged }: {
  visible: boolean; onClose: () => void; onChanged: () => void;
}) {
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [generating, setGenerating] = useState(false);
  const pollTimer = useRef<any>(null);

  const fetchCards = useCallback(async () => {
    try { return await api<Card[]>("GET", "/character/cards"); }
    catch { return null; }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const r = await fetchCards();
    if (r) setCards(r);
    setLoading(false);
  }, [fetchCards]);

  useFocusEffect(useCallback(() => { if (visible) load(); }, [visible, load]));

  useEffect(() => () => { if (pollTimer.current) clearInterval(pollTimer.current); }, []);

  const stopPoll = () => { if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; } };

  const generate = async () => {
    if (generating) return;
    setGenerating(true);
    try {
      await api("POST", "/character/cards/generate");
    } catch (e: any) {
      setGenerating(false);
      toast(e.message || "生成失败", "err");
      return;
    }
    // 服务端是异步：返回 202，生成完通过 WS card_update 推。
    // 这里轮询 /character/cards，直到检测到新卡或超时（3 分钟）。
    const baseCount = cards.length;
    const startAt = Date.now();
    pollTimer.current = setInterval(async () => {
      const r = await fetchCards();
      if (!r) return;
      if (r.length > baseCount) {
        stopPoll();
        setCards(r);
        setGenerating(false);
        onChanged();
      } else if (Date.now() - startAt > 180_000) {
        stopPoll();
        setGenerating(false);
        toast("生成超时，稍后下拉刷新", "err");
      }
    }, 3000);
  };

  const activate = async (id: number) => {
    setBusyId(id);
    try {
      await api("PATCH", `/character/cards/${id}/activate`);
      await load();
      onChanged();
    } catch (e: any) {
      toast(e.message || "切换失败", "err");
    } finally { setBusyId(null); }
  };

  const download = async (url: string) => {
    try {
      const perm = await MediaLibrary.requestPermissionsAsync();
      if (!perm.granted) { toast("需要相册权限", "err"); return; }
      const filename = `card-${Date.now()}.${url.split(".").pop()?.split("?")[0] || "jpg"}`;
      const tmp = `${FileSystem.cacheDirectory}${filename}`;
      const r = await FileSystem.downloadAsync(url, tmp);
      await MediaLibrary.saveToLibraryAsync(r.uri);
      toast("已保存到相册");
    } catch (e: any) {
      toast(e.message || "下载失败", "err");
    }
  };

  const onLongPressCard = (item: Card) => {
    const items: any[] = [];
    if (!item.is_active) items.push({ label: "切换为当前", onPress: () => activate(item.id) });
    items.push({ label: "下载到相册", onPress: () => download(item.image_url) });
    items.push({
      label: "删除", destructive: true, onPress: async () => {
        try { await api("DELETE", `/character/cards/${item.id}`); await load(); onChanged(); }
        catch (e: any) { toast(e.message || "删除失败", "err"); }
      },
    });
    actionSheet("角色卡", items);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <SafeAreaView edges={["top", "bottom"]} style={cs.container}>
        <View style={cs.header}>
          <Pressable onPress={onClose} style={cs.iconBtn} hitSlop={8}>
            <IconBack size={24} color="#fff" />
          </Pressable>
          <Text style={cs.title}>角色卡片</Text>
          <Pressable
            onPress={generate}
            disabled={generating}
            style={[cs.newCardBtn, generating && { opacity: 0.5 }]}
            hitSlop={8}
          >
            {generating
              ? <ActivityIndicator color="#7e6fd0" />
              : <Text style={cs.newCardText}>＋ 新建</Text>}
          </Pressable>
        </View>

        {generating ? (
          <Text style={cs.generatingHint}>正在生成新卡片，会消耗每日插图额度，约 30 秒~ 2 分钟…</Text>
        ) : null}

        {loading ? (
          <View style={cs.center}><ActivityIndicator color="#7e6fd0" /></View>
        ) : (
          <FlatList
            data={cards}
            keyExtractor={(it) => String(it.id)}
            numColumns={2}
            contentContainerStyle={{ padding: 8 }}
            columnWrapperStyle={{ gap: 8 }}
            ListEmptyComponent={<Text style={cs.empty}>还没有角色卡，点右上角生成一张</Text>}
            renderItem={({ item }) => (
              <Pressable
                style={[cs.cardItem, item.is_active ? cs.cardItemActive : null]}
                onPress={() => !item.is_active && activate(item.id)}
                onLongPress={() => onLongPressCard(item)}
                delayLongPress={400}
              >
                <Image source={{ uri: item.image_url }} style={cs.cardImg} resizeMode="cover" />
                {item.is_active ? (
                  <View style={cs.activeBadge}>
                    <Text style={cs.activeText}>使用中</Text>
                  </View>
                ) : null}
                {busyId === item.id ? (
                  <View style={cs.busyMask}><ActivityIndicator color="#fff" /></View>
                ) : null}
              </Pressable>
            )}
          />
        )}

        <Text style={cs.hint}>点击切换 · 长按更多操作</Text>
      </SafeAreaView>
    </Modal>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f17" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0f0f17" },

  hero: { width: "100%", justifyContent: "flex-end" },
  heroImg: { ...StyleSheet.absoluteFillObject, justifyContent: "flex-end" },
  heroTopBar: { position: "absolute", top: 0, right: 0 },
  cardsBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center", justifyContent: "center",
    margin: 12, opacity: 0.9,
  },
  heroContent: { padding: 20, paddingBottom: 24 },
  heroName: { color: "#fff", fontSize: 32, fontWeight: "800", textShadowColor: "rgba(0,0,0,0.6)", textShadowRadius: 8, textShadowOffset: { width: 0, height: 1 } },
  heartRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
  heart: { color: "#f472b6", fontSize: 16 },
  affValue: { color: "#fff", fontSize: 16, fontWeight: "600" },
  heroEmpty: { color: "#bbb", fontSize: 16 },

  body: { paddingHorizontal: 16, marginTop: 4 },
  entryGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 14 },
  entry: { width: "31.5%", backgroundColor: "#1c1c2a", borderRadius: 10, alignItems: "center", paddingVertical: 14, gap: 6 },
  entryIconWrap: { height: 24, alignItems: "center", justifyContent: "center" },
  entryLabel: { color: "#ddd", fontSize: 12 },

  editRow: { flexDirection: "row", gap: 8 },
  editBtn: { borderWidth: 1, borderColor: "#7e6fd0", paddingVertical: 10, borderRadius: 10, alignItems: "center" },
  editText: { color: "#7e6fd0", fontSize: 13 },

  section: { paddingHorizontal: 16, marginTop: 24 },
  sectionTitle: { color: "#888", fontSize: 13, marginBottom: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 10, backgroundColor: "#1c1c2a", marginBottom: 6 },
  rowActive: { borderWidth: 1, borderColor: "#7e6fd0" },
  avatarSm: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  avatarSmImg: { width: "100%", height: "100%" },
  avatarSmText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  rowName: { color: "#fff", flex: 1, fontSize: 15 },
  activeTag: { color: "#7e6fd0", fontSize: 12, fontWeight: "600" },
  switchHint: { color: "#666", fontSize: 12 },
  empty: { color: "#666", textAlign: "center", marginVertical: 24 },

  newWrap: { alignItems: "center", marginTop: 18 },
  newBtn: { backgroundColor: "#7e6fd0", paddingHorizontal: 28, paddingVertical: 12, borderRadius: 24 },
  newBtnText: { color: "#fff", fontWeight: "600", fontSize: 15 },
});

const cs = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f17" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 8, paddingVertical: 6, minHeight: 48,
    borderBottomWidth: 1, borderBottomColor: "#1c1c2a",
  },
  iconBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: "#fff", fontSize: 17, fontWeight: "600", textAlign: "center" },
  newCardBtn: { paddingHorizontal: 12, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#7e6fd0", marginRight: 8 },
  newCardText: { color: "#7e6fd0", fontSize: 13, fontWeight: "600" },

  cardItem: {
    flex: 1, aspectRatio: 9 / 16, backgroundColor: "#1c1c2a",
    borderRadius: 10, marginBottom: 8, overflow: "hidden",
    borderWidth: 2, borderColor: "transparent",
  },
  cardItemActive: { borderColor: "#7e6fd0" },
  cardImg: { width: "100%", height: "100%" },
  activeBadge: {
    position: "absolute", left: 8, top: 8,
    backgroundColor: "rgba(126,111,208,0.9)",
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6,
  },
  activeText: { color: "#fff", fontSize: 11, fontWeight: "600" },
  busyMask: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center", justifyContent: "center",
  },

  empty: { color: "#666", textAlign: "center", marginTop: 60 },
  generatingHint: { color: "#999", fontSize: 12, textAlign: "center", paddingHorizontal: 24, paddingVertical: 8, backgroundColor: "rgba(126,111,208,0.08)" },
  hint: { color: "#666", fontSize: 12, textAlign: "center", paddingVertical: 10 },
});

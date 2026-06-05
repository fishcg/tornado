import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  ActivityIndicator, Dimensions, FlatList, Image, Modal, Pressable,
  RefreshControl, ScrollView, StyleSheet, Text, View,
} from "react-native";
import { api } from "@/api/client";
import PageHeader from "@/components/PageHeader";

type GalleryItem = {
  id: number;
  session_id: number;
  image_url: string;
  image_prompt: string | null;
  created_at: string;
  title: string;
};

const PAGE = 20;
const COLS = 3;
const GAP = 4;
const CELL = (Dimensions.get("window").width - GAP * (COLS + 1)) / COLS;

export default function CharacterGallery() {
  const router = useRouter();
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [preview, setPreview] = useState<GalleryItem | null>(null);
  const [character, setCharacter] = useState<{ name: string } | null>(null);

  const buildUrl = useCallback((offset: number, charName: string | null) => {
    const u = `/gallery?offset=${offset}&limit=${PAGE}`;
    return charName ? `${u}&character=${encodeURIComponent(charName)}` : u;
  }, []);

  const load = useCallback(async (offset: number, replace: boolean) => {
    try {
      const char = character ?? await api<{ name: string }>("GET", "/character").catch(() => null);
      if (char && !character) setCharacter(char);
      const data = await api<{ items: GalleryItem[]; hasMore: boolean }>(
        "GET", buildUrl(offset, char?.name || null)
      );
      setItems((cur) => replace ? data.items : [...cur, ...data.items]);
      setHasMore(data.hasMore);
    } catch {} finally {
      setLoading(false); setRefreshing(false); setLoadingMore(false);
    }
  }, [buildUrl, character]);

  useFocusEffect(useCallback(() => { load(0, true); }, [load]));

  const onEnd = () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    load(items.length, false);
  };

  if (loading) return <View style={s.center}><ActivityIndicator color="#7e6fd0" /></View>;

  return (
    <View style={s.container}>
      <PageHeader title={character?.name || "画廊"} />
      <FlatList
        data={items}
        numColumns={COLS}
        keyExtractor={(it) => String(it.id)}
        contentContainerStyle={{ padding: GAP, paddingBottom: 40 }}
        columnWrapperStyle={{ gap: GAP }}
        ItemSeparatorComponent={() => <View style={{ height: GAP }} />}
        refreshControl={
          <RefreshControl refreshing={refreshing} tintColor="#7e6fd0"
            onRefresh={() => { setRefreshing(true); load(0, true); }} />
        }
        ListEmptyComponent={<Text style={s.empty}>这个角色还没有图片</Text>}
        onEndReached={onEnd}
        onEndReachedThreshold={0.5}
        ListFooterComponent={loadingMore ? <ActivityIndicator color="#7e6fd0" style={{ marginVertical: 16 }} /> : null}
        renderItem={({ item }) => (
          <Pressable onPress={() => setPreview(item)}>
            <Image source={{ uri: item.image_url }} style={{ width: CELL, height: CELL, borderRadius: 6, backgroundColor: "#1c1c2a" }} />
          </Pressable>
        )}
      />

      <Modal visible={!!preview} transparent animationType="fade" onRequestClose={() => setPreview(null)}>
        <Pressable style={s.previewBg} onPress={() => setPreview(null)}>
          <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 20 }}>
            {preview && (
              <View>
                <Image source={{ uri: preview.image_url }} style={s.previewImg} resizeMode="contain" />
                {preview.image_prompt ? <Text style={s.previewPrompt}>{preview.image_prompt}</Text> : null}
                <Pressable style={s.gotoBtn} onPress={() => { const id = preview.session_id; setPreview(null); router.push(`/chat/${id}`); }}>
                  <Text style={s.gotoText}>去对话「{preview.title}」</Text>
                </Pressable>
              </View>
            )}
          </ScrollView>
        </Pressable>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f17" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0f0f17" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 56, paddingBottom: 12 },
  back: { color: "#7e6fd0", fontSize: 15 },
  title: { color: "#fff", fontSize: 18, fontWeight: "700" },
  empty: { color: "#666", textAlign: "center", marginTop: 60 },
  previewBg: { flex: 1, backgroundColor: "rgba(0,0,0,0.92)" },
  previewImg: { width: "100%", aspectRatio: 1, borderRadius: 8 },
  previewPrompt: { color: "#bbb", fontSize: 13, marginTop: 12 },
  gotoBtn: { marginTop: 16, backgroundColor: "#7e6fd0", padding: 12, borderRadius: 8, alignItems: "center" },
  gotoText: { color: "#fff", fontWeight: "600" },
});

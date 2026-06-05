import { useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { IconBack } from "./Icons";

type Props = {
  title: string;
  right?: React.ReactNode;
};

export default function PageHeader({ title, right }: Props) {
  const router = useRouter();
  return (
    <SafeAreaView edges={["top"]} style={s.safe}>
      <View style={s.header}>
        <Pressable onPress={() => router.back()} style={s.iconBtn} hitSlop={8}>
          <IconBack size={24} color="#fff" />
        </Pressable>
        <Text style={s.title} numberOfLines={1}>{title}</Text>
        <View style={s.right}>{right}</View>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { backgroundColor: "#0f0f17" },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingVertical: 6, paddingHorizontal: 8,
    borderBottomWidth: 1, borderBottomColor: "#1c1c2a",
    minHeight: 48,
  },
  iconBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, color: "#fff", fontSize: 17, fontWeight: "600", textAlign: "center" },
  right: { minWidth: 40, alignItems: "flex-end" },
});

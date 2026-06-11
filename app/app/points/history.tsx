import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { api } from "@/api/client";
import PageHeader from "@/components/PageHeader";

type CheckinRecord = {
  checkin_date: string; // YYYY-MM-DD
  points: number;
  streak: number;
  created_at: string;
};

type Status = {
  balance: number;
  streak: number;
  history: CheckinRecord[];
};

const WEEK_LABELS = ["日", "一", "二", "三", "四", "五", "六"];
const pad2 = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad2(m + 1)}-${pad2(d)}`;

export default function CheckinHistory() {
  const [history, setHistory] = useState<CheckinRecord[]>([]);
  const [balance, setBalance] = useState(0);
  const [streak, setStreak] = useState(0);
  const [loading, setLoading] = useState(true);

  // 当前展示的年月（默认本月）
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth()); // 0-11

  // 按展示的年月拉取该月签到记录（全局字段 balance/streak 始终返回）
  const load = useCallback(async (y: number, m: number) => {
    try {
      const monthParam = `${y}-${pad2(m + 1)}`;
      const st = await api<Status>("GET", `/checkin/status?month=${monthParam}`);
      setHistory(st.history ?? []);
      setBalance(st.balance ?? 0);
      setStreak(st.streak ?? 0);
    } catch {}
    finally { setLoading(false); }
  }, []);

  // 切换月份或重新聚焦时按当前年月加载
  useFocusEffect(useCallback(() => { load(year, month); }, [load, year, month]));

  // 签到日期 → 积分 的映射，便于格子里查
  const checkinMap = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of history) m[r.checkin_date] = r.points;
    return m;
  }, [history]);

  const todayStr = ymd(now.getFullYear(), now.getMonth(), now.getDate());
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth();

  // 本月在展示月份内签到的天数
  const monthCheckins = useMemo(() => {
    const prefix = `${year}-${pad2(month + 1)}-`;
    return history.filter((r) => r.checkin_date.startsWith(prefix)).length;
  }, [history, year, month]);

  // 构造网格：前置空格 + 当月每一天
  const cells = useMemo(() => {
    const firstWeekday = new Date(year, month, 1).getDay(); // 0=周日
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const arr: (number | null)[] = [];
    for (let i = 0; i < firstWeekday; i++) arr.push(null);
    for (let d = 1; d <= daysInMonth; d++) arr.push(d);
    return arr;
  }, [year, month]);

  const goPrev = () => {
    setHistory([]);
    if (month === 0) { setYear(year - 1); setMonth(11); }
    else setMonth(month - 1);
  };
  const goNext = () => {
    if (isCurrentMonth) return; // 不允许查看未来月份
    setHistory([]);
    if (month === 11) { setYear(year + 1); setMonth(0); }
    else setMonth(month + 1);
  };

  return (
    <View style={s.container}>
      <PageHeader title="签到记录" />
      {loading ? (
        <View style={s.center}><ActivityIndicator color="#7e6fd0" /></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 12 }}>
          <View style={s.statBar}>
            <View style={s.statItem}>
              <Text style={s.statValue}>🐟 {balance}</Text>
              <Text style={s.statLabel}>当前余额</Text>
            </View>
            <View style={s.statDivider} />
            <View style={s.statItem}>
              <Text style={s.statValue}>{streak} 天</Text>
              <Text style={s.statLabel}>连续签到</Text>
            </View>
            <View style={s.statDivider} />
            <View style={s.statItem}>
              <Text style={s.statValue}>{monthCheckins} 天</Text>
              <Text style={s.statLabel}>本月签到</Text>
            </View>
          </View>

          <View style={s.calCard}>
            <View style={s.calHeader}>
              <Pressable onPress={goPrev} hitSlop={10} style={s.navBtn}>
                <Text style={s.navText}>‹</Text>
              </Pressable>
              <Text style={s.calTitle}>{year} 年 {month + 1} 月</Text>
              <Pressable onPress={goNext} hitSlop={10} style={s.navBtn} disabled={isCurrentMonth}>
                <Text style={[s.navText, isCurrentMonth && s.navTextDisabled]}>›</Text>
              </Pressable>
            </View>

            <View style={s.weekRow}>
              {WEEK_LABELS.map((w) => (
                <View key={w} style={s.weekCell}><Text style={s.weekText}>{w}</Text></View>
              ))}
            </View>

            <View style={s.grid}>
              {cells.map((d, i) => {
                if (d === null) return <View key={`e${i}`} style={s.cell} />;
                const dateStr = ymd(year, month, d);
                const points = checkinMap[dateStr];
                const checked = points !== undefined;
                const isToday = dateStr === todayStr;
                return (
                  <View key={dateStr} style={s.cell}>
                    <View style={[s.dayWrap, checked && s.dayChecked, isToday && s.dayToday]}>
                      <Text style={[s.dayNum, checked && s.dayNumChecked]}>{d}</Text>
                      {checked
                        ? <Text style={s.dayPts}>+{points}</Text>
                        : <Text style={s.dayPtsPlaceholder} />}
                    </View>
                  </View>
                );
              })}
            </View>

            <View style={s.legend}>
              <View style={s.legendItem}>
                <View style={[s.legendDot, s.dayChecked]} />
                <Text style={s.legendText}>已签到</Text>
              </View>
              <View style={s.legendItem}>
                <View style={[s.legendDot, s.dayToday]} />
                <Text style={s.legendText}>今天</Text>
              </View>
            </View>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f17" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },

  statBar: { flexDirection: "row", alignItems: "center", backgroundColor: "#1c1c2a", borderRadius: 12, paddingVertical: 16, marginBottom: 12 },
  statItem: { flex: 1, alignItems: "center" },
  statValue: { color: "#fff", fontSize: 18, fontWeight: "700" },
  statLabel: { color: "#888", fontSize: 12, marginTop: 4 },
  statDivider: { width: 1, height: 28, backgroundColor: "#2a2a3a" },

  calCard: { backgroundColor: "#1c1c2a", borderRadius: 12, padding: 12 },
  calHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 6, paddingVertical: 4, marginBottom: 6 },
  calTitle: { color: "#fff", fontSize: 16, fontWeight: "600" },
  navBtn: { width: 40, height: 32, alignItems: "center", justifyContent: "center" },
  navText: { color: "#7e6fd0", fontSize: 26, fontWeight: "700", lineHeight: 28 },
  navTextDisabled: { color: "#3a3a4a" },

  weekRow: { flexDirection: "row", marginBottom: 4 },
  weekCell: { width: `${100 / 7}%`, alignItems: "center", paddingVertical: 6 },
  weekText: { color: "#888", fontSize: 12 },

  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { width: `${100 / 7}%`, aspectRatio: 1, alignItems: "center", justifyContent: "center", padding: 2 },
  dayWrap: { width: "100%", height: "100%", alignItems: "center", justifyContent: "center", borderRadius: 8 },
  dayChecked: { backgroundColor: "#7e6fd0" },
  dayToday: { borderWidth: 1.5, borderColor: "#7e6fd0" },
  dayNum: { color: "#ccc", fontSize: 14 },
  dayNumChecked: { color: "#fff", fontWeight: "700" },
  dayPts: { color: "#fff", fontSize: 10, marginTop: 1 },
  dayPtsPlaceholder: { height: 12, marginTop: 1 },

  legend: { flexDirection: "row", justifyContent: "center", gap: 20, marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: "#2a2a3a" },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  legendDot: { width: 14, height: 14, borderRadius: 4 },
  legendText: { color: "#888", fontSize: 12 },
});

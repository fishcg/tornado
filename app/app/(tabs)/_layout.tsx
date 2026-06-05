import { Tabs } from "expo-router";
import { IconChat, IconUser, IconSettings, IconMe } from "@/components/Icons";

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: "#0f0f17", borderTopColor: "#2a2a3a" },
        tabBarActiveTintColor: "#7e6fd0",
        tabBarInactiveTintColor: "#777",
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "聊天",
          tabBarIcon: ({ color, size }) => <IconChat size={size - 4} color={color} />,
        }}
      />
      <Tabs.Screen
        name="character"
        options={{
          title: "角色",
          tabBarIcon: ({ color, size }) => <IconUser size={size - 4} color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "设置",
          tabBarIcon: ({ color, size }) => <IconSettings size={size - 4} color={color} />,
        }}
      />
      <Tabs.Screen
        name="me"
        options={{
          title: "我的",
          tabBarIcon: ({ color, size }) => <IconMe size={size - 4} color={color} />,
        }}
      />
    </Tabs>
  );
}

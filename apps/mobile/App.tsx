import { StatusBar } from "expo-status-bar";
import { SafeAreaView, StyleSheet, Text, View } from "react-native";

const providers = ["Google", "Apple", "Facebook", "Guest"];

export default function App() {
  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="dark" />
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>Prototype Foundation</Text>
        <Text style={styles.title}>Muralist</Text>
        <Text style={styles.copy}>
          Shared mobile groundwork for OAuth-first access, guest mode, palette
          reduction, and configurable paint-brand planning assumptions.
        </Text>
        <View style={styles.providerRow}>
          {providers.map((provider) => (
            <View key={provider} style={styles.pill}>
              <Text style={styles.pillText}>{provider}</Text>
            </View>
          ))}
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#efe5d4",
    padding: 24
  },
  hero: {
    flex: 1,
    justifyContent: "center",
    gap: 16
  },
  eyebrow: {
    textTransform: "uppercase",
    letterSpacing: 2,
    color: "#356c54",
    fontSize: 12
  },
  title: {
    fontSize: 48,
    lineHeight: 52,
    color: "#16221b",
    fontWeight: "700"
  },
  copy: {
    fontSize: 18,
    lineHeight: 28,
    color: "#415047"
  },
  providerRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10
  },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: "#fffaf1",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(22, 34, 27, 0.12)"
  },
  pillText: {
    color: "#16221b",
    fontSize: 14
  }
});


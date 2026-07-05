import SwiftUI

struct StandupView: View {
    @EnvironmentObject var standup: Standup

    var body: some View {
        ZStack {
            DuskBackground()
            VStack(spacing: 0) {
                header
                AgentStrip(agents: standup.agents)
                    .padding(.vertical, 14)
                ScrollView {
                    VStack(spacing: 12) {
                        ForEach(standup.feed) { item in
                            ItemCard(item: item)
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.bottom, 24)
                }
                .scrollDismissesKeyboard(.interactively)
                TypeBar()
                    .padding(.bottom, 8)
                CallBar()
            }
        }
    }

    private var header: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Standup")
                    .font(.wkDisplay(30, .bold))
                    .foregroundStyle(WK.textPrimary)
                Text("you're the director")
                    .font(.wkBody(13))
                    .foregroundStyle(WK.textTertiary)
            }
            Spacer()
            HStack(spacing: 5) {
                Circle().fill(standup.statusLine == "live" ? WK.signal : WK.textTertiary)
                    .frame(width: 7, height: 7)
                Text("MARA").font(.wkBody(12, .semibold)).foregroundStyle(WK.signal)
                Text("· \(standup.statusLine)").font(.wkBody(12)).foregroundStyle(WK.textTertiary)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 10)
    }
}

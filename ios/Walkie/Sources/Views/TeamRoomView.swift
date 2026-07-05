import SwiftUI

// The Team Room tab — watch #work live while you walk. Mara hands off, the engineers
// ack and report in their own voice. Eyes-only: nothing here is spoken; only the EM on
// the Standup tab reaches your ear.
struct TeamRoomView: View {
    @EnvironmentObject var room: TeamRoom

    var body: some View {
        ZStack {
            DuskBackground()
            VStack(spacing: 0) {
                header
                AgentStrip(agents: room.roster)
                    .padding(.vertical, 14)
                if room.lines.isEmpty { emptyState } else { feed }
            }
        }
    }

    private var header: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Team Room")
                    .font(.wkDisplay(30, .bold))
                    .foregroundStyle(WK.textPrimary)
                Text("watching #work")
                    .font(.wkBody(13))
                    .foregroundStyle(WK.textTertiary)
            }
            Spacer()
            Image(systemName: "eye")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(WK.textTertiary)
        }
        .padding(.horizontal, 20)
        .padding(.top, 10)
    }

    private var feed: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 10) {
                    ForEach(room.lines) { line in
                        RoomLineRow(line: line).id(line.id)
                    }
                }
                .padding(.horizontal, 18)
                .padding(.bottom, 24)
            }
            .onChange(of: room.lines.count) { _ in
                if let last = room.lines.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Spacer()
            Image(systemName: "person.3")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(WK.textTertiary)
            Text("Quiet room.")
                .font(.wkDisplay(18, .semibold))
                .foregroundStyle(WK.textSecondary)
            Text("Hand Mara a build on the Standup tab\nand the team works it out here.")
                .font(.wkBody(14))
                .foregroundStyle(WK.textTertiary)
                .multilineTextAlignment(.center)
            Spacer()
        }
        .padding(.horizontal, 30)
    }
}

// One line in the room — speaker-colored, chat style. Mara (the conductor) sits left in
// amber; engineers carry their own accent.
struct RoomLineRow: View {
    let line: RoomLine

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Circle().fill(accent).frame(width: 7, height: 7)
                Text(line.speaker.uppercased())
                    .font(.wkBody(12, .semibold))
                    .foregroundStyle(accent)
                if line.isEM {
                    Text("· conductor").font(.wkBody(11)).foregroundStyle(WK.textTertiary)
                }
            }
            Text(line.text)
                .font(.wkBody(15))
                .foregroundStyle(WK.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WK.rCard).fill(WK.surface))
        .overlay(RoundedRectangle(cornerRadius: WK.rCard).stroke(WK.hairline, lineWidth: 1))
    }

    // Stable color per teammate so the room is scannable at a glance while walking.
    private var accent: Color {
        switch line.speaker.lowercased() {
        case "mara": return WK.signal
        case "theo": return WK.build
        case "cora": return WK.alert
        case "nia":  return WK.shipped
        default:     return WK.textSecondary
        }
    }
}

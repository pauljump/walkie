import SwiftUI

struct AgentStrip: View {
    let agents: [Agent]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(agents) { agent in
                    AgentChip(agent: agent)
                }
            }
            .padding(.horizontal, 18)
        }
    }
}

struct AgentChip: View {
    let agent: Agent

    var body: some View {
        HStack(spacing: 9) {
            ZStack {
                Circle().fill(WK.surfaceHi).frame(width: 34, height: 34)
                Text(String(agent.name.prefix(1)))
                    .font(.wkDisplay(15, .bold))
                    .foregroundStyle(WK.textPrimary)
                Circle().fill(agent.status.color)
                    .frame(width: 9, height: 9)
                    .overlay(Circle().stroke(WK.surface, lineWidth: 2))
                    .offset(x: 13, y: 13)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(agent.name)
                    .font(.wkBody(14, .semibold))
                    .foregroundStyle(WK.textPrimary)
                Text(agent.role == .em ? "EM" : agent.status.label)
                    .font(.wkBody(11))
                    .foregroundStyle(agent.role == .em ? WK.signal : agent.status.color)
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 12)
        .background(RoundedRectangle(cornerRadius: WK.rChip).fill(WK.surface))
        .overlay(RoundedRectangle(cornerRadius: WK.rChip).stroke(WK.hairline, lineWidth: 1))
    }
}

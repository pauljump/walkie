import SwiftUI

struct ItemCard: View {
    @EnvironmentObject var standup: Standup
    let item: StandupItem

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Circle().fill(accent).frame(width: 7, height: 7)
                Text(item.speaker.uppercased())
                    .font(.wkBody(12, .semibold))
                    .foregroundStyle(accent)
                Spacer()
                Text(tag)
                    .font(.wkBody(11, .medium))
                    .foregroundStyle(WK.textTertiary)
            }
            Text(item.text)
                .font(.wkBody(16, item.kind == .director ? .regular : .medium))
                .foregroundStyle(WK.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            if let detail = item.detail {
                Text(detail)
                    .font(.wkBody(12))
                    .foregroundStyle(WK.textSecondary)
            }
            if item.kind == .decision {
                HStack(spacing: 10) {
                    ForEach(item.options, id: \.self) { opt in
                        let isPrimary = (opt == item.options.first)
                        Button {
                            standup.answerDecision(item, opt)
                        } label: {
                            Text(opt)
                                .font(.wkBody(14, .semibold))
                                .foregroundStyle(isPrimary ? WK.bgBottom : WK.textPrimary)
                                .padding(.vertical, 10)
                                .frame(maxWidth: .infinity)
                                .background(RoundedRectangle(cornerRadius: 12)
                                    .fill(isPrimary ? WK.signal : WK.surfaceHi))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.top, 2)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WK.rCard).fill(cardFill))
        .overlay(RoundedRectangle(cornerRadius: WK.rCard).stroke(stroke, lineWidth: 1))
    }

    private var accent: Color {
        switch item.kind {
        case .emSummary: return WK.signal
        case .shipped:   return WK.shipped
        case .decision:  return WK.alert
        case .director:  return WK.textSecondary
        }
    }
    private var tag: String {
        switch item.kind {
        case .emSummary: return "standup"
        case .shipped:   return "ready to ship"
        case .decision:  return "needs you"
        case .director:  return "you"
        }
    }
    private var cardFill: Color { item.kind == .director ? WK.surfaceHi : WK.surface }
    private var stroke: Color { item.kind == .decision ? WK.alert.opacity(0.5) : WK.hairline }
}

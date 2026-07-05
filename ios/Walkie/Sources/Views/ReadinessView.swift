import SwiftUI

// The "is my Mac ready?" screen. Reused two places: the last step of onboarding, and a link
// from Settings. It runs one honest GET /api/status check and shows one of three things:
// checking, ready, or not-yet with a plain list of what's missing and how to fix it.
//
// Copy is deliberately flat: a plain line that says the state, then a short line that lands
// it. No hype, no hedging, tell the user why + how + what to do.
struct ReadinessView: View {
    @EnvironmentObject var broker: BrokerClient
    @StateObject private var readiness = Readiness()

    // When the user reaches "You're ready" and taps the primary button. Onboarding uses this
    // to dismiss the whole flow; a standalone Settings link can leave it nil.
    var onReady: (() -> Void)? = nil
    // A place to send the user to fix things by hand (opens Settings). Onboarding wires this
    // to its "type it instead" fallback.
    var onFix: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: 22) {
            switch readiness.status {
            case .checking:  checking
            case .ready:     ready
            case .notReady(let missing): notReady(missing)
            }
        }
        .frame(maxWidth: .infinity)
        .task { await readiness.check(broker.config) }
    }

    private var checking: some View {
        VStack(spacing: 14) {
            ProgressView().tint(WK.signal).scaleEffect(1.3)
            Text("Checking your Mac...")
                .font(.wkBody(15))
                .foregroundStyle(WK.textSecondary)
        }
        .padding(.vertical, 30)
    }

    private var ready: some View {
        VStack(spacing: 16) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(WK.shipped)
            Text("You're ready.")
                .font(.wkDisplay(26, .bold))
                .foregroundStyle(WK.textPrimary)
            Text("Say the thing and keep walking.")
                .font(.wkBody(15))
                .foregroundStyle(WK.textSecondary)

            // Positive confirmations: shows the user WHERE things live. The AI key line is the
            // point — it sits on the Mac, never on the phone (clears up a real beta confusion).
            if !readiness.confirmations.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(readiness.confirmations, id: \.self) { line in
                        HStack(spacing: 8) {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.system(size: 15))
                                .foregroundStyle(WK.shipped)
                            Text(line)
                                .font(.wkBody(14))
                                .foregroundStyle(WK.textSecondary)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .background(RoundedRectangle(cornerRadius: WK.rCard).fill(WK.surface))
                .overlay(RoundedRectangle(cornerRadius: WK.rCard).stroke(WK.hairline, lineWidth: 1))
                .padding(.top, 4)
            }

            if let onReady {
                Button(action: onReady) {
                    Text("Start walking")
                        .font(.wkBody(16, .semibold))
                        .foregroundStyle(WK.bgBottom)
                        .padding(.vertical, 14).frame(maxWidth: .infinity)
                        .background(RoundedRectangle(cornerRadius: 16).fill(WK.signal))
                }
                .buttonStyle(.plain)
                .padding(.top, 8)
            }
        }
        .padding(.vertical, 20)
    }

    private func notReady(_ missing: [String]) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 22))
                    .foregroundStyle(WK.error)
                Text("Not ready yet.")
                    .font(.wkDisplay(22, .bold))
                    .foregroundStyle(WK.textPrimary)
            }

            Text("Here's what to sort out first:")
                .font(.wkBody(14, .semibold))
                .foregroundStyle(WK.textSecondary)

            VStack(alignment: .leading, spacing: 8) {
                ForEach(missing, id: \.self) { item in
                    HStack(alignment: .top, spacing: 8) {
                        Text("•").foregroundStyle(WK.error)
                        Text(item)
                            .font(.wkBody(14))
                            .foregroundStyle(WK.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            HStack(spacing: 12) {
                if let onFix {
                    Button(action: onFix) {
                        Text("Fix it")
                            .font(.wkBody(15, .semibold))
                            .foregroundStyle(WK.textPrimary)
                            .padding(.vertical, 12).frame(maxWidth: .infinity)
                            .background(RoundedRectangle(cornerRadius: 14).fill(WK.surfaceHi))
                            .overlay(RoundedRectangle(cornerRadius: 14).stroke(WK.hairline, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
                Button {
                    Task { await readiness.check(broker.config) }
                } label: {
                    Text("Check again")
                        .font(.wkBody(15, .semibold))
                        .foregroundStyle(WK.bgBottom)
                        .padding(.vertical, 12).frame(maxWidth: .infinity)
                        .background(RoundedRectangle(cornerRadius: 14).fill(WK.signal))
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background(RoundedRectangle(cornerRadius: WK.rCard).fill(WK.surface))
        .overlay(RoundedRectangle(cornerRadius: WK.rCard).stroke(WK.hairline, lineWidth: 1))
    }
}

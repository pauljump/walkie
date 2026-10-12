import SwiftUI

/// Shown the first time you'd use a second subscription. One screen, one price, one button.
struct PaywallSheet: View {
    /// The CLI you were about to use.
    var wanted: Agent? = nil
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Walkie for all subscriptions").font(.title2.weight(.bold))
                    Text(lead).font(.subheadline).foregroundStyle(WK.textSecondary)
                }
                VStack(alignment: .leading, spacing: 14) {
                    point("square.grid.2x2", "Every CLI you pay for", "Claude Code, Codex, Antigravity and Grok, in one place, on your own logins.")
                    point("arrow.triangle.branch", "Continue on another plan", "When one runs out, the conversation keeps going on another, with its transcript.")
                    point("square.split.2x2", "Send to projects across plans", "One planning conversation becomes one session per project, each on the model you pick.")
                    point("person.crop.circle.badge.checkmark", "Kept up for you", "Built by someone who uses it every day, and kept working as the CLIs change. One purchase, every device on your Apple Account.")
                }
                Spacer()
                Text("Rather build your own? The exact prompt is free at walkie.cc/build.")
                    .font(.footnote).foregroundStyle(WK.textTertiary)
                if let e = store.lastError { Text(e).font(.footnote).foregroundStyle(WK.error) }
                Button {
                    Task { await store.buy(); if store.purchased { dismiss() } }
                } label: {
                    HStack {
                        if store.busy { ProgressView().tint(WK.onAccent) } else { Text("Buy once · \(store.priceLabel)").fontWeight(.semibold) }
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                .disabled(store.busy || store.product == nil)
                HStack {
                    Button("Restore purchase") { Task { await store.restore(); if store.purchased { dismiss() } } }
                    Spacer()
                    Button("Not now") { dismiss() }
                }
                .font(.footnote)
                .foregroundStyle(WK.textSecondary)
            }
            .padding(22)
            .background(WK.bg)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button { dismiss() } label: { Image(systemName: "xmark") } } }
            .task { if store.product == nil { await store.refresh() } }
        }
        .presentationDetents([.large])
    }

    private var lead: String {
        let free = store.freeHarness?.name ?? "one subscription"
        if let wanted { return "Walkie is free for \(free). To use \(wanted.name) too, buy it once." }
        return "Walkie is free for \(free). Everything else you pay for, for one price."
    }

    private func point(_ icon: String, _ title: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).font(.title3).frame(width: 28).foregroundStyle(WK.textPrimary)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(text).font(.footnote).foregroundStyle(WK.textSecondary)
            }
        }
    }
}

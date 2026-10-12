import SwiftUI

struct UsageProvider: Decodable, Identifiable, Hashable {
    struct Window: Decodable, Hashable {
        let name: String
        let usedPct: Int?
        let resetsAt: Double?
        var resets: Date? { resetsAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
    }
    let id: String
    let label: String
    let plan: String?
    let state: String
    let windows: [Window]
    let note: String?

    /// The window that's closest to running out: the one that decides whether you can work.
    var tightest: Window? { windows.max { ($0.usedPct ?? 0) < ($1.usedPct ?? 0) } }
    var color: Color {
        switch state {
        case "full": WK.error
        case "warning": WK.waiting
        case "ok": WK.ok
        default: WK.textTertiary
        }
    }
    var short: String {
        switch state {
        case "full":
            if let r = tightest?.resets { return "back \(r.formatted(.dateTime.weekday(.abbreviated).hour()))" }
            return "full"
        case "signed-out": return "sign in"
        case "unmetered": return "no meter"
        case "unknown": return "?"
        default: return "\(100 - (tightest?.usedPct ?? 0))% left"
        }
    }
    /// When the window closest to running out resets: "8:39 PM" today, else "Mon 11:59 PM".
    var nextReset: String? { tightest?.resets.map { Self.when($0) } }
    /// The reset lines as one phrase, for VoiceOver.
    var resetLine: String? { resetLines.isEmpty ? nil : resetLines.joined(separator: ", ") }
    /// One line per window when a plan has several (Claude: 5 hours and week), soonest first:
    /// "5h resets 1:00 PM", "week resets Tue 12:00 AM". A single window: "resets Sat 1:09 PM".
    /// Today's resets show only the time. None when full (`short` already says when it's back).
    var resetLines: [String] {
        guard state != "full" else { return [] }
        let timed = windows.filter { $0.resets != nil }.sorted { $0.resets! < $1.resets! }
        if timed.count == 1 { return ["resets \(Self.when(timed[0].resets!))"] }
        return timed.map { "\(Self.shortName($0.name)) resets \(Self.when($0.resets!))" }
    }
    static func shortName(_ name: String) -> String {
        switch name.lowercased() {
        case "5 hours": "5h"
        case "week": "week"
        default: name.lowercased()
        }
    }
    static func when(_ d: Date, now: Date = .now) -> String {
        if Calendar.current.isDate(d, inSameDayAs: now) { return d.formatted(.dateTime.hour().minute()) }
        return d.formatted(.dateTime.weekday(.abbreviated).hour().minute())
    }
}

extension Bridge {
    func usage(fresh: Bool = false) async throws -> [UsageProvider] {
        struct R: Decodable { let providers: [UsageProvider] }
        let r: R = try await get("api/usage", query: fresh ? ["fresh": "1"] : [:])
        return r.providers
    }
}

/// One row, every subscription: how much is left before each runs out. Tap for details.
struct UsageStrip: View {
    var compact = false
    @Environment(Bridge.self) private var bridge
    @State private var all: [UsageProvider] = []
    /// Plans Walkie can't meter stay in the detail sheet, not the strip.
    private var providers: [UsageProvider] { all.filter { $0.state != "unmetered" } }
    @State private var showDetail = false

    var body: some View {
        Button { showDetail = true } label: {
            if compact {
                HStack(spacing: 6) {
                    ForEach(providers) { p in ring(p, size: 24, line: 2.5, font: .system(size: 9, weight: .bold).monospacedDigit()) }
                }
            } else {
                HStack(alignment: .top, spacing: 0) {
                    ForEach(providers) { p in
                        VStack(spacing: 4) {
                            ring(p, size: 40, line: 4, font: .caption.weight(.semibold).monospacedDigit())
                            Text(p.label).font(.caption.weight(.semibold)).lineLimit(1)
                            // One line: when the window that runs out first resets (or when a full plan is back).
                            Text(p.state == "full" ? p.short : p.nextReset.map { "resets \($0)" } ?? p.short)
                                .font(.caption2).foregroundStyle(p.state == "full" ? WK.error : WK.textTertiary)
                                .lineLimit(1).minimumScaleFactor(0.8)
                        }
                        .frame(maxWidth: .infinity)
                    }
                }
                .padding(.vertical, 4)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Subscription usage")
        .task {
            while !Task.isCancelled {
                if let p = try? await bridge.usage() { all = p }
                try? await Task.sleep(for: .seconds(60))
            }
        }
        .sheet(isPresented: $showDetail) { UsageDetail(providers: $all) }
    }

    /// One plan: the ring fills with what's left; the number inside is the percent left ("–" = no meter).
    private func ring(_ p: UsageProvider, size: CGFloat, line: CGFloat, font: Font) -> some View {
        ZStack {
            Circle().stroke(WK.surfaceHi, lineWidth: line)
            Circle().trim(from: 0, to: p.windows.isEmpty ? 0 : CGFloat(100 - (p.tightest?.usedPct ?? 0)) / 100)
                .stroke(p.color, style: StrokeStyle(lineWidth: line, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text(p.windows.isEmpty ? String(p.label.prefix(2)) : "\(100 - (p.tightest?.usedPct ?? 0))")
                .font(font)
                .foregroundStyle(p.state == "full" ? WK.error : p.windows.isEmpty ? WK.textTertiary : WK.textPrimary)
        }
        .frame(width: size, height: size)
        .accessibilityLabel("\(p.label): \(p.short)\(p.resetLine.map { ", \($0)" } ?? "")")
    }
}

struct UsageDetail: View {
    @Binding var providers: [UsageProvider]
    @Environment(Bridge.self) private var bridge
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                ForEach(providers) { p in
                    Section {
                        if p.windows.isEmpty {
                            Text(p.note ?? "No meter").foregroundStyle(WK.textSecondary)
                        }
                        ForEach(p.windows, id: \.name) { w in
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    Text(w.name)
                                    Spacer()
                                    Text("\(w.usedPct ?? 0)% used").foregroundStyle(WK.textSecondary)
                                }
                                ProgressView(value: Double(w.usedPct ?? 0), total: 100).tint(p.color)
                                if let r = w.resets {
                                    Text("Resets \(r.formatted(.relative(presentation: .named))) · \(r.formatted(date: .abbreviated, time: .shortened))")
                                        .font(.caption).foregroundStyle(WK.textTertiary)
                                }
                            }
                        }
                    } header: {
                        HStack {
                            Text(p.label)
                            if let plan = p.plan { Text(plan.uppercased()).foregroundStyle(WK.textTertiary) }
                        }
                    }
                }
                Section {
                    Text("Claude, ChatGPT and Google report real plan usage. Grok only reports usage per conversation, so it has no meter here.")
                        .font(.footnote).foregroundStyle(WK.textTertiary)
                }
            }
            .navigationTitle("Usage")
            .refreshable { if let p = try? await bridge.usage(fresh: true) { providers = p } }
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

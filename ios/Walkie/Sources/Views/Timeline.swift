import SwiftUI
import UIKit

// The pieces of a conversation's timeline: messages, tool steps, results.

struct EventRow: View {
    let event: AgentEvent
    let agent: Agent
    var resolved = false

    var body: some View {
        switch event.kind {
        case "user":
            let parts = WalkiePrompt.split(event.text ?? "")
            VStack(alignment: .trailing, spacing: 6) {
                if let note = parts.note { WalkieNote(text: note, detail: event.text ?? "") }
                if let yours = parts.yours {
                    let attached = AttachmentText.split(yours)
                    if !attached.body.isEmpty {
                        HStack {
                            Spacer(minLength: 40)
                            SelectableText(text: attached.body, markdown: false, color: UIColor(WK.textPrimary), hug: true)
                                .padding(.horizontal, 12).padding(.vertical, 8)
                                .background(WK.surfaceHi, in: RoundedRectangle(cornerRadius: 16))
                        }
                    }
                    if !attached.paths.isEmpty { SentAttachments(paths: attached.paths) }
                }
                if event.voice == true { SpokenMark() }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        case "text":
            VStack(alignment: .leading, spacing: 6) {
                MarkdownText(text: event.text ?? "")
                if event.voice == true { SpokenMark() }
            }
        case "thinking":
            DisclosureGroup {
                SelectableText(text: event.text ?? "", markdown: false, font: .style(.footnote), color: UIColor(WK.textSecondary))
            } label: {
                Label("Thinking", systemImage: "brain").font(.footnote).foregroundStyle(WK.textTertiary)
            }
            .tint(WK.textTertiary)
        case "tool":
            ToolRow(event: event)
        case "ask":
            AskSummary(event: event)
        case "result":
            ResultLine(event: event)
        case "error":
            Label(event.text ?? "Error", systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(WK.error)
        default:
            Text(event.text ?? "").font(.footnote).foregroundStyle(WK.textTertiary)
        }
    }
}

struct ToolRow: View {
    let event: AgentEvent
    @State private var open = false
    private var hasBody: Bool { [event.detail, event.diff, event.output].contains { !($0 ?? "").isEmpty } }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { if hasBody { withAnimation(.snappy) { open.toggle() } } } label: {
                HStack(spacing: 8) {
                    statusIcon.frame(width: 14)
                    Text(event.title ?? event.tool ?? "Tool")
                        .font(WK.mono).foregroundStyle(WK.textSecondary)
                        .lineLimit(open ? nil : 1)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 0)
                    if hasBody {
                        Image(systemName: "chevron.right").font(.caption2).foregroundStyle(WK.textTertiary)
                            .rotationEffect(.degrees(open ? 90 : 0))
                    }
                }
            }
            .buttonStyle(.plain)
            if open {
                if let d = event.detail, !d.isEmpty { SelectableText(text: d, markdown: false, font: .style(.caption1), color: UIColor(WK.textSecondary)) }
                if let diff = event.diff, !diff.isEmpty { DiffView(diff: diff) }
                if let out = event.output, !out.isEmpty {
                    ScrollView(.horizontal) {
                        SelectableText(text: out, markdown: false, font: .mono(.caption2), color: UIColor(WK.textSecondary))
                    }
                    .padding(8).background(WK.surface, in: RoundedRectangle(cornerRadius: 8))
                }
            }
        }
        .padding(.vertical, 2)
    }

    // Spinner → check (or ✕) with a small transition rather than a jump.
    @ViewBuilder private var statusIcon: some View {
        Group {
            switch event.status {
            case "running": ProgressView().controlSize(.mini).transition(.opacity)
            case "error": Image(systemName: "xmark").font(.caption2.bold()).foregroundStyle(WK.error).transition(.scale.combined(with: .opacity))
            default: Image(systemName: "checkmark").font(.caption2.bold()).foregroundStyle(WK.textTertiary).transition(.scale.combined(with: .opacity))
            }
        }
        .animation(.snappy, value: event.status)
    }
}

struct DiffView: View {
    let diff: String
    @State private var expanded = false
    private var lines: [Substring] { diff.split(separator: "\n", omittingEmptySubsequences: false) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView(.horizontal) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lines.prefix(expanded ? lines.count : 40).enumerated()), id: \.offset) { _, line in
                        Text(line.isEmpty ? " " : String(line))
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(color(line))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(background(line))
                    }
                }
            }
            if lines.count > 40 && !expanded {
                Button("Show all \(lines.count) lines") { expanded = true }.font(.caption).padding(.top, 6)
            }
        }
        .padding(8)
        .background(WK.surface, in: RoundedRectangle(cornerRadius: 8))
    }

    private func color(_ l: Substring) -> Color {
        if l.hasPrefix("+++") || l.hasPrefix("---") { return WK.textSecondary }
        if l.hasPrefix("+") { return WK.ok }
        if l.hasPrefix("-") { return WK.error }
        if l.hasPrefix("@@") { return WK.codex }
        return WK.textSecondary
    }
    private func background(_ l: Substring) -> Color {
        if l.hasPrefix("+") && !l.hasPrefix("+++") { return WK.ok.opacity(0.08) }
        if l.hasPrefix("-") && !l.hasPrefix("---") { return WK.error.opacity(0.08) }
        return .clear
    }
}

struct AskSummary: View {
    let event: AgentEvent
    var body: some View {
        Label(event.title ?? "Question", systemImage: event.type == "question" ? "questionmark.bubble" : "hand.raised")
            .font(.footnote).foregroundStyle(WK.textTertiary).lineLimit(1)
    }
}

struct ResultLine: View {
    let event: AgentEvent
    var body: some View {
        HStack(spacing: 6) {
            Rectangle().fill(WK.hairline).frame(height: 1)
            Text(label).font(.caption2).foregroundStyle(event.ok == false ? WK.error : WK.textTertiary).fixedSize()
            Rectangle().fill(WK.hairline).frame(height: 1)
        }
        .padding(.vertical, 4)
    }
    private var label: String {
        var parts: [String] = [event.ok == false ? (event.text ?? "Stopped") : "Done"]
        if let ms = event.durationMs, ms > 0 { parts.append(ms >= 60_000 ? "\(Int(ms / 60_000))m \(Int(ms / 1000) % 60)s" : "\(Int(ms / 1000))s") }
        return parts.joined(separator: " · ")
    }
}

/// One row in the timeline: a single event, or a run of tool steps shown as one line.
struct TimelineItem: Identifiable {
    let events: [AgentEvent]
    var id: String { events.first?.id ?? UUID().uuidString }

    /// Three or more tool calls in a row (thinking in between counts as part of the run) collapse.
    static func group(_ events: [AgentEvent]) -> [TimelineItem] {
        var out: [TimelineItem] = []
        var run: [AgentEvent] = []
        func flush() {
            if run.filter({ $0.kind == "tool" }).count >= 3 { out.append(TimelineItem(events: run)) }
            else { out += run.map { TimelineItem(events: [$0]) } }
            run = []
        }
        for (i, ev) in events.enumerated() {
            // A message that's followed straight away by more tool steps is in-between chatter: it goes
            // with the run. The last message of a turn stays out, where you'll see it.
            let nextIsTool = events[(i + 1)...].first { $0.kind != "thinking" }?.kind == "tool"
            if ev.kind == "tool" || (ev.kind == "thinking" && !run.isEmpty) || (ev.kind == "text" && nextIsTool) { run.append(ev) } else { flush(); out.append(TimelineItem(events: [ev])) }
        }
        flush()
        return out
    }
}

/// A run of tool steps as one quiet line: how many, what's still going, what failed, and the latest.
/// Tap to see each step.
struct ToolGroup: View {
    let steps: [AgentEvent]
    @State private var open = false
    private var tools: [AgentEvent] { steps.filter { $0.kind == "tool" } }
    private var running: Int { tools.filter { $0.status == "running" }.count }
    private var failed: Int { tools.filter { $0.status == "error" }.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { withAnimation(.snappy) { open.toggle() } } label: {
                HStack(spacing: 8) {
                    Group {
                        if running > 0 { ProgressView().controlSize(.mini) }
                        else { Image(systemName: open ? "chevron.down" : "chevron.right").font(.caption2.weight(.semibold)) }
                    }
                    .frame(width: 14).foregroundStyle(WK.textTertiary)
                    Text("\(tools.count) steps").font(.footnote.weight(.medium)).foregroundStyle(WK.textSecondary)
                    if running > 0 { Text("· \(running) running").font(.footnote).foregroundStyle(WK.textTertiary) }
                    if failed > 0 { Text("· \(failed) failed").font(.footnote).foregroundStyle(WK.error) }
                    if !open, let last = tools.last?.title ?? tools.last?.tool {
                        Text("· \(last)").font(WK.mono).foregroundStyle(WK.textTertiary).lineLimit(1).truncationMode(.middle)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(steps) { ev in
                        if ev.kind == "tool" { ToolRow(event: ev) }
                        else if ev.kind == "text" { MarkdownText(text: ev.text ?? "", style: .footnote, color: WK.textSecondary) }
                        else { Text(ev.text ?? "").font(.footnote).foregroundStyle(WK.textTertiary).lineLimit(3) }
                    }
                }
                .padding(.leading, 22)
            }
        }
    }
}

/// Under a message that was said out loud in a voice chat.
struct SpokenMark: View {
    var body: some View {
        Label("Spoken", systemImage: "waveform").font(.caption2).foregroundStyle(WK.textTertiary)
    }
}

/// When a message was sent, shown after you tap it.
struct MessageTime: View {
    let ms: Double
    var trailing = false
    var body: some View {
        let date = Date(timeIntervalSince1970: ms / 1000)
        Text(Calendar.current.isDateInToday(date) ? date.formatted(date: .omitted, time: .shortened) : date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().hour().minute()))
            .font(.caption2).foregroundStyle(WK.textTertiary)
            .frame(maxWidth: .infinity, alignment: trailing ? .trailing : .leading)
            .transition(.opacity)
    }
}

/// What Walkie sent the agent on your behalf (a continued conversation's transcript): one quiet line, tap to read it all.
struct WalkieNote: View {
    let text: String
    let detail: String
    @State private var open = false
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { withAnimation(.snappy) { open.toggle() } } label: {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.triangle.branch").font(.caption2)
                    Text(text).font(.caption)
                    Image(systemName: "chevron.right").font(.caption2).rotationEffect(.degrees(open ? 90 : 0))
                }
                .foregroundStyle(WK.textTertiary)
            }
            .buttonStyle(.plain)
            if open {
                SelectableText(text: detail, markdown: false, font: .style(.caption1), color: UIColor(WK.textSecondary))
                    .padding(10).background(WK.surface, in: RoundedRectangle(cornerRadius: 10))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

import SwiftUI
import UIKit

// Message text: markdown you can select any part of, and the small copy button on code.

// Paragraph text with inline markdown, plus fenced code blocks rendered as monospaced panels.
struct MarkdownText: View {
    let text: String
    var style: UIFont.TextStyle = .body
    var color: Color = WK.textPrimary
    /// Extra items in the long-press menu; each gets the selected text.
    var actions: [SelectableText.Action] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, seg in
                if seg.code {
                    SelectableText(text: seg.text, markdown: false, font: .mono(.caption1), color: UIColor(color), actions: actions)
                        .padding(10).padding(.trailing, 24)
                        .background(WK.surface, in: RoundedRectangle(cornerRadius: 8))
                        .overlay(alignment: .topTrailing) { CopyButton(text: seg.text).padding(6) }
                } else {
                    SelectableText(text: seg.text, font: .style(style), color: UIColor(color), actions: actions)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private var segments: [(code: Bool, text: String)] {
        var out: [(Bool, String)] = []
        for (i, part) in text.components(separatedBy: "```").enumerated() {
            if i % 2 == 1 {
                var body = part
                if let nl = body.firstIndex(of: "\n") { body = String(body[body.index(after: nl)...]) } // drop the language tag
                out.append((true, body.trimmingCharacters(in: .newlines)))
            } else {
                let t = part.trimmingCharacters(in: .whitespacesAndNewlines)
                if !t.isEmpty { out.append((false, t)) }
            }
        }
        return out
    }
}

extension String {
    var abbreviatedPath: String {
        replacingOccurrences(of: #"^/Users/[^/]+/"#, with: "~/", options: .regularExpression)
    }
}

/// A small copy button (code blocks): copies, confirms with a check and a tap.
struct CopyButton: View {
    let text: String
    @State private var copied = 0
    var body: some View {
        Button { UIPasteboard.general.string = text; copied += 1 } label: {
            Image(systemName: copied > 0 ? "checkmark" : "doc.on.doc")
                .font(.caption2.weight(.semibold))
                .contentTransition(.symbolEffect(.replace))
                .foregroundStyle(WK.textTertiary)
                .frame(width: 26, height: 26)
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.success, trigger: copied)
        .task(id: copied) { if copied > 0 { try? await Task.sleep(for: .seconds(1.5)); copied = 0 } }
        .accessibilityLabel("Copy code")
    }
}

import SwiftUI
import UIKit

/// Text you can select like anywhere else on iOS: long-press, drag the handles, Copy / Look Up / Share.
/// SwiftUI's own `textSelection` can only copy a whole block, so messages use this instead.
/// Extra menu items (e.g. "Reply in thread") get the selected text, or the whole text if nothing is selected.
struct SelectableText: UIViewRepresentable {
    struct Action {
        let title: String
        let image: String
        let run: (String) -> Void
    }

    let text: String
    var markdown = true
    var font: UIFont = .preferredFont(forTextStyle: .body)
    var color: UIColor = .label
    var actions: [Action] = []
    /// Take only the width the text needs (chat bubbles) instead of the full row.
    var hug = false

    func makeUIView(context: Context) -> UITextView {
        let v = UITextView()
        v.isEditable = false
        v.isSelectable = true
        v.isScrollEnabled = false
        v.backgroundColor = .clear
        v.textContainerInset = .zero
        v.textContainer.lineFragmentPadding = 0
        v.adjustsFontForContentSizeCategory = true
        v.dataDetectorTypes = [.link]
        v.delegate = context.coordinator
        v.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return v
    }

    func updateUIView(_ v: UITextView, context: Context) {
        context.coordinator.parent = self
        let rendered = markdown ? Self.render(text, font: font, color: color) : NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color])
        if v.attributedText != rendered { v.attributedText = rendered }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        var width = proposal.width ?? UIScreen.main.bounds.width
        if hug, let t = uiView.attributedText {
            let used = t.boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil).width
            width = min(width, ceil(used) + 2)
        }
        let size = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: ceil(size.height))
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: SelectableText
        init(_ parent: SelectableText) { self.parent = parent }

        func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
            guard !parent.actions.isEmpty else { return nil }
            let chosen = (textView.text as NSString).substring(with: range).trimmingCharacters(in: .whitespacesAndNewlines)
            let text = chosen.isEmpty ? parent.text : chosen
            let extra = parent.actions.map { a in UIAction(title: a.title, image: UIImage(systemName: a.image)) { _ in a.run(text) } }
            return UIMenu(children: extra + suggestedActions)
        }
    }

    /// Inline markdown (bold, italic, `code`, links; headings read as bold) in UIKit fonts.
    static func render(_ s: String, font: UIFont, color: UIColor) -> NSAttributedString {
        let md = s.replacingOccurrences(of: #"(?m)^#{1,6} (.+)$"#, with: "**$1**", options: .regularExpression)
        guard let parsed = try? AttributedString(markdown: md, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) else {
            return NSAttributedString(string: s, attributes: [.font: font, .foregroundColor: color])
        }
        let out = NSMutableAttributedString()
        for run in parsed.runs {
            let piece = String(parsed[run.range].characters)
            var f = font
            let intent = run.inlinePresentationIntent ?? []
            var traits: UIFontDescriptor.SymbolicTraits = []
            if intent.contains(.stronglyEmphasized) { traits.insert(.traitBold) }
            if intent.contains(.emphasized) { traits.insert(.traitItalic) }
            if !traits.isEmpty, let d = font.fontDescriptor.withSymbolicTraits(traits) { f = UIFont(descriptor: d, size: font.pointSize) }
            if intent.contains(.code) { f = .monospacedSystemFont(ofSize: font.pointSize * 0.92, weight: .regular) }
            var attrs: [NSAttributedString.Key: Any] = [.font: f, .foregroundColor: color]
            if let link = run.link { attrs[.link] = link }
            out.append(NSAttributedString(string: piece, attributes: attrs))
        }
        return out
    }
}

extension UIFont {
    static func style(_ style: UIFont.TextStyle) -> UIFont { .preferredFont(forTextStyle: style) }
    static func mono(_ style: UIFont.TextStyle) -> UIFont { .monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: style).pointSize, weight: .regular) }
}

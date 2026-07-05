import SwiftUI

enum AgentRole: String {
    case em = "EM"
    case engineer = "Engineer"
    case ios = "iOS"
    case design = "Design"
    case qa = "QA"
    case security = "Security"
}

enum AgentStatus {
    case building, blocked, idle, shipped

    var color: Color {
        switch self {
        case .building: return WK.build
        case .blocked:  return WK.alert
        case .idle:     return WK.textTertiary
        case .shipped:  return WK.shipped
        }
    }
    var label: String {
        switch self {
        case .building: return "building"
        case .blocked:  return "blocked"
        case .idle:     return "idle"
        case .shipped:  return "shipped"
        }
    }
}

struct Agent: Identifiable {
    let id = UUID()
    let name: String
    let role: AgentRole
    var status: AgentStatus
}

enum ItemKind {
    case emSummary   // the EM's curated opener
    case shipped     // a report shipped, wants review
    case decision    // a fork the Director must answer
    case director    // the Director's own voice reply
}

struct StandupItem: Identifiable {
    let id = UUID()
    let speaker: String
    let kind: ItemKind
    let text: String
    var detail: String? = nil
    var options: [String] = []
}

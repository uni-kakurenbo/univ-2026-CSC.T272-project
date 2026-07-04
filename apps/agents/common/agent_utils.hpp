#pragma once

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <compare>
#include <cstddef>
#include <deque>
#include <cstdlib>
#include <iomanip>
#include <limits>
#include <map>
#include <optional>
#include <queue>
#include <random>
#include <ranges>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

namespace agent {

inline int clamp_intelligence_level(int level) {
    return std::clamp(level, 0, 3);
}

inline int parse_intelligence_level(int argc, char* argv[]) {
    int level = 3;
    if (const char* env = std::getenv("AGENT_INTELLIGENCE_LEVEL")) {
        try {
            level = std::stoi(env);
        } catch (...) {
            level = 3;
        }
    }

    for (int i = 1; i + 1 < argc; ++i) {
        if (std::string_view(argv[i]) == "--intelligence-level") {
            try {
                level = std::stoi(argv[i + 1]);
            } catch (...) {
                level = 3;
            }
            break;
        }
    }
    return clamp_intelligence_level(level);
}

struct Point {
    int x = 0;
    int y = 0;

    friend bool operator==(const Point&, const Point&) = default;

    friend std::strong_ordering operator<=>(const Point& lhs, const Point& rhs) {
        if (const auto by_row = lhs.y <=> rhs.y; by_row != 0) return by_row;
        return lhs.x <=> rhs.x;
    }
};

enum class Direction { Up, Down, Left, Right, Stay, Observe };

enum class Cell { Unknown = -1, Empty = 0, Wall = 1, Goal = 2 };

inline const std::vector<Direction>& all_directions() {
    static const std::vector<Direction> values = {
        Direction::Up,
        Direction::Down,
        Direction::Left,
        Direction::Right,
        Direction::Stay,
    };
    return values;
}

inline const std::vector<Direction>& move_directions() {
    static const std::vector<Direction> values = {
        Direction::Up,
        Direction::Down,
        Direction::Left,
        Direction::Right,
    };
    return values;
}

inline std::string_view to_string(Direction direction) {
    static constexpr std::array names{"UP", "DOWN", "LEFT", "RIGHT", "STAY", "OBSERVE"};
    return names[std::to_underlying(direction)];
}

inline Point delta(Direction direction) {
    static constexpr std::array<Point, 6> deltas{{{0, -1}, {0, 1}, {-1, 0}, {1, 0}, {0, 0}, {0, 0}}};
    return deltas[std::to_underlying(direction)];
}

inline Point moved(Point point, Direction direction) {
    const auto d = delta(direction);
    return {point.x + d.x, point.y + d.y};
}

inline std::pair<Direction, Direction> perpendicular(Direction direction) {
    static constexpr std::array<std::pair<Direction, Direction>, 6> table{{
        {Direction::Left, Direction::Right},
        {Direction::Right, Direction::Left},
        {Direction::Down, Direction::Up},
        {Direction::Up, Direction::Down},
        {Direction::Stay, Direction::Stay},
        {Direction::Observe, Direction::Observe},
    }};
    return table[std::to_underlying(direction)];
}

inline std::vector<std::pair<Direction, double>> duck_slip_outcomes(Direction action) {
    constexpr double kSlipProbability = 0.2;
    if (action == Direction::Stay) return {{Direction::Stay, 1.0}};
    const auto [left, right] = perpendicular(action);
    return {
        {action, 1.0 - kSlipProbability},
        {left, kSlipProbability / 4.0},
        {right, kSlipProbability / 4.0},
        {Direction::Stay, kSlipProbability / 2.0},
    };
}

inline int manhattan(Point a, Point b) {
    return std::abs(a.x - b.x) + std::abs(a.y - b.y);
}

inline double euclidean(Point a, Point b) {
    const double dx = static_cast<double>(a.x - b.x);
    const double dy = static_cast<double>(a.y - b.y);
    return std::sqrt(dx * dx + dy * dy);
}

class Grid {
public:
    Grid() = default;

    Grid(int height, int width, Cell initial)
        : height_(height), width_(width), cells_(height, std::vector<Cell>(width, initial)) {}

    int height() const { return height_; }
    int width() const { return width_; }

    bool in_bounds(Point point) const {
        return 0 <= point.x && point.x < width_ && 0 <= point.y && point.y < height_;
    }

    Cell get(Point point) const {
        if (!in_bounds(point)) return Cell::Wall;
        return cells_[point.y][point.x];
    }

    void set(Point point, Cell cell) {
        if (in_bounds(point)) cells_[point.y][point.x] = cell;
    }

    bool passable(Point point, bool unknown_passable = true) const {
        if (!in_bounds(point)) return false;
        const auto cell = get(point);
        return cell != Cell::Wall && (unknown_passable || cell != Cell::Unknown);
    }

    const std::vector<std::vector<Cell>>& cells() const { return cells_; }

private:
    int height_ = 0;
    int width_ = 0;
    std::vector<std::vector<Cell>> cells_;
};

class Json {
public:
    using Array = std::vector<Json>;
    using Object = std::map<std::string, Json>;
    using Value = std::variant<std::nullptr_t, bool, double, std::string, Array, Object>;

    Json() : value_(nullptr) {}
    explicit Json(Value value) : value_(std::move(value)) {}

    static Json parse(const std::string& text) {
        Parser parser(text);
        auto value = parser.parse_value();
        parser.skip_ws();
        if (!parser.finished()) throw std::runtime_error("unexpected trailing JSON input");
        return value;
    }

    bool is_object() const { return std::holds_alternative<Object>(value_); }
    bool is_array() const { return std::holds_alternative<Array>(value_); }
    bool is_string() const { return std::holds_alternative<std::string>(value_); }
    bool is_number() const { return std::holds_alternative<double>(value_); }
    bool is_bool() const { return std::holds_alternative<bool>(value_); }
    bool is_null() const { return std::holds_alternative<std::nullptr_t>(value_); }

    const Object& object() const { return std::get<Object>(value_); }
    const Array& array() const { return std::get<Array>(value_); }
    const std::string& string() const { return std::get<std::string>(value_); }
    double number() const { return std::get<double>(value_); }
    bool boolean() const { return std::get<bool>(value_); }

    const Json* find(const std::string& key) const {
        if (!is_object()) return nullptr;
        const auto& object = this->object();
        const auto it = object.find(key);
        return it == object.end() ? nullptr : &it->second;
    }

    const Json& at(const std::string& key) const {
        const auto* value = find(key);
        if (!value) throw std::runtime_error("missing JSON key: " + key);
        return *value;
    }

    bool has(const std::string& key) const { return find(key) != nullptr; }

    int as_int(int fallback = 0) const {
        if (!is_number()) return fallback;
        return static_cast<int>(std::llround(number()));
    }

    double as_double(double fallback = 0.0) const {
        if (!is_number()) return fallback;
        return number();
    }

    std::string as_string(std::string fallback = {}) const {
        return is_string() ? string() : std::move(fallback);
    }

private:
    class Parser {
    public:
        explicit Parser(const std::string& text) : text_(text) {}

        Json parse_value() {
            skip_ws();
            if (finished()) throw std::runtime_error("empty JSON value");
            const char ch = peek();
            if (ch == '{') return parse_object();
            if (ch == '[') return parse_array();
            if (ch == '"') return Json(parse_string());
            if (ch == 't') return parse_literal("true", Json(true));
            if (ch == 'f') return parse_literal("false", Json(false));
            if (ch == 'n') return parse_literal("null", Json(nullptr));
            if (ch == '-' || std::isdigit(static_cast<unsigned char>(ch))) return parse_number();
            throw std::runtime_error("invalid JSON value");
        }

        void skip_ws() {
            while (!finished() && std::isspace(static_cast<unsigned char>(peek()))) ++pos_;
        }

        bool finished() const { return pos_ >= text_.size(); }

    private:
        Json parse_object() {
            consume('{');
            Object object;
            skip_ws();
            if (try_consume('}')) return Json(std::move(object));

            while (true) {
                skip_ws();
                const auto key = parse_string();
                skip_ws();
                consume(':');
                object.emplace(key, parse_value());
                skip_ws();
                if (try_consume('}')) break;
                consume(',');
            }

            return Json(std::move(object));
        }

        Json parse_array() {
            consume('[');
            Array array;
            skip_ws();
            if (try_consume(']')) return Json(std::move(array));

            while (true) {
                array.push_back(parse_value());
                skip_ws();
                if (try_consume(']')) break;
                consume(',');
            }

            return Json(std::move(array));
        }

        std::string parse_string() {
            consume('"');
            std::string result;
            while (!finished()) {
                const char ch = advance();
                if (ch == '"') return result;
                if (ch != '\\') {
                    result.push_back(ch);
                    continue;
                }

                if (finished()) throw std::runtime_error("unterminated JSON escape");
                const char escaped = advance();
                switch (escaped) {
                    case '"':
                    case '\\':
                    case '/':
                        result.push_back(escaped);
                        break;
                    case 'b':
                        result.push_back('\b');
                        break;
                    case 'f':
                        result.push_back('\f');
                        break;
                    case 'n':
                        result.push_back('\n');
                        break;
                    case 'r':
                        result.push_back('\r');
                        break;
                    case 't':
                        result.push_back('\t');
                        break;
                    case 'u':
                        for (int i = 0; i < 4; ++i) {
                            if (finished() || !std::isxdigit(static_cast<unsigned char>(advance()))) {
                                throw std::runtime_error("invalid unicode escape");
                            }
                        }
                        result.push_back('?');
                        break;
                    default:
                        throw std::runtime_error("invalid JSON escape");
                }
            }
            throw std::runtime_error("unterminated JSON string");
        }

        Json parse_number() {
            const auto start = pos_;
            if (peek() == '-') ++pos_;
            consume_digits();
            if (!finished() && peek() == '.') {
                ++pos_;
                consume_digits();
            }
            if (!finished() && (peek() == 'e' || peek() == 'E')) {
                ++pos_;
                if (!finished() && (peek() == '+' || peek() == '-')) ++pos_;
                consume_digits();
            }
            return Json(std::stod(text_.substr(start, pos_ - start)));
        }

        Json parse_literal(const std::string& literal, Json value) {
            if (text_.compare(pos_, literal.size(), literal) != 0) {
                throw std::runtime_error("invalid JSON literal");
            }
            pos_ += literal.size();
            return value;
        }

        void consume_digits() {
            if (finished() || !std::isdigit(static_cast<unsigned char>(peek()))) {
                throw std::runtime_error("expected digit");
            }
            while (!finished() && std::isdigit(static_cast<unsigned char>(peek()))) ++pos_;
        }

        char peek() const { return text_[pos_]; }

        char advance() { return text_[pos_++]; }

        void consume(char expected) {
            skip_ws();
            if (finished() || peek() != expected) {
                throw std::runtime_error(std::string("expected '") + expected + "'");
            }
            ++pos_;
        }

        bool try_consume(char expected) {
            skip_ws();
            if (!finished() && peek() == expected) {
                ++pos_;
                return true;
            }
            return false;
        }

        const std::string& text_;
        std::size_t pos_ = 0;
    };

    Value value_;
};

inline Point parse_point(const Json& json) {
    const auto& values = json.array();
    if (values.size() < 2) throw std::runtime_error("point requires two coordinates");
    return {values[0].as_int(), values[1].as_int()};
}

inline std::vector<std::vector<int>> parse_int_grid(const Json& json) {
    std::vector<std::vector<int>> grid;
    for (const auto& row : json.array()) {
        std::vector<int> parsed_row;
        for (const auto& value : row.array()) parsed_row.push_back(value.as_int());
        grid.push_back(std::move(parsed_row));
    }
    return grid;
}

inline Cell cell_from_int(int value) {
    switch (value) {
        case -1:
            return Cell::Unknown;
        case 0:
            return Cell::Empty;
        case 1:
            return Cell::Wall;
        case 2:
            return Cell::Goal;
        default:
            return Cell::Unknown;
    }
}

inline Point map_size_to_dimensions(const Json& map_size) {
    const auto& values = map_size.array();
    if (values.size() < 2) throw std::runtime_error("map_size requires [H,W]");
    return {values[1].as_int(), values[0].as_int()};
}

inline int sensor_value(const Json& root, const std::string& name) {
    const auto* sensors = root.find("sensors");
    if (!sensors) return 0;
    const auto* value = sensors->find(name);
    return value ? value->as_int() : 0;
}

inline double sensor_value_double(const Json& root, const std::string& name) {
    const auto* sensors = root.find("sensors");
    if (!sensors) return -1.0;
    const auto* value = sensors->find(name);
    return value ? value->as_double() : -1.0;
}

inline double observation_likelihood_normal(double observation, double actual_distance, double std_dev) {
    if (std_dev <= 0.0) return observation == actual_distance ? 1.0 : 0.0;
    double diff = observation - actual_distance;
    const double pi = std::acos(-1.0);
    return std::exp(-0.5 * (diff * diff) / (std_dev * std_dev)) / (std_dev * std::sqrt(2.0 * pi));
}

inline double probability_of_sensor(const std::string& sensor, int distance) {
    if (distance >= 1'000'000) return sensor == "radio" ? 0.1 : 0.0;

    if (sensor == "sound") {
        if (distance == 1) return 0.95;
        if (distance == 2) return 0.70;
        if (distance == 3) return 0.20;
        return 0.0;
    }
    if (sensor == "heat") return std::max(0.0, 1.0 - 0.35 * static_cast<double>(distance));
    if (sensor == "radio") return distance <= 2 ? 0.8 : 0.1;

    return 0.0;
}

inline double observation_likelihood(int fired, double activation_probability) {
    constexpr double eps = 1e-6;
    const double p = std::clamp(activation_probability, eps, 1.0 - eps);
    return fired ? p : 1.0 - p;
}

inline double entropy(const std::vector<std::vector<double>>& distribution) {
    auto positive = distribution | std::views::join | std::views::filter([](double p) { return p > 0.0; });
    return -std::ranges::fold_left(positive, 0.0, [](double acc, double p) { return acc + p * std::log(p); });
}

inline double normalized_entropy(const std::vector<std::vector<double>>& distribution) {
    int count = 0;
    for (const auto& row : distribution) count += static_cast<int>(row.size());
    if (count <= 1) return 0.0;
    return entropy(distribution) / std::log(static_cast<double>(count));
}

inline Point argmax_distribution(const std::vector<std::vector<double>>& distribution) {
    Point best{0, 0};
    double best_value = -1.0;
    for (const auto& [y, row] : distribution | std::views::enumerate) {
        for (const auto& [x, value] : row | std::views::enumerate) {
            if (value > best_value) {
                best_value = value;
                best = {static_cast<int>(x), static_cast<int>(y)};
            }
        }
    }
    return best;
}

inline double peak_probability(const std::vector<std::vector<double>>& distribution) {
    const auto flat = distribution | std::views::join;
    return std::ranges::fold_left(flat, 0.0, [](double best, double value) { return std::max(best, value); });
}

struct TargetEstimate {
    Point predicted_position;
    std::vector<std::vector<double>> distribution;
    double confidence;
};

inline void append_target_estimate(std::ostringstream& output, const TargetEstimate& estimate) {
    output << R"({"predictedPosition":[)" << estimate.predicted_position.x << ',' << estimate.predicted_position.y << R"(],"positionDistribution":[)";

    for (std::size_t y = 0; y < estimate.distribution.size(); ++y) {
        if (y > 0) output << ',';
        output << '[';
        for (std::size_t x = 0; x < estimate.distribution[y].size(); ++x) {
            if (x > 0) output << ',';
            output << std::clamp(estimate.distribution[y][x], 0.0, 1.0);
        }
        output << ']';
    }
    output << R"(],"confidence":)" << std::clamp(estimate.confidence, 0.0, 1.0) << '}';
}

inline std::string response_envelope(
    std::string_view action,
    std::optional<TargetEstimate> opponent_estimate = std::nullopt,
    std::optional<TargetEstimate> goal_estimate = std::nullopt
) {
    std::ostringstream output;
    output << std::setprecision(10);
    output << R"({"action":")" << action << R"(")";

    if (opponent_estimate || goal_estimate) {
        output << R"(,"telemetry":{)";
        bool has_prev = false;
        if (opponent_estimate) {
            output << R"("opponent":)";
            append_target_estimate(output, *opponent_estimate);
            has_prev = true;
        }
        if (goal_estimate) {
            if (has_prev) output << ',';
            output << R"("goal":)";
            append_target_estimate(output, *goal_estimate);
        }
        output << "}";
    }
    output << "}";
    return output.str();
}

class DistanceMap {
public:
    DistanceMap() = default;

    DistanceMap(int height, int width, int initial)
        : distances_(height, std::vector<int>(width, initial)) {}

    int get(Point point) const {
        if (point.y < 0 || point.y >= static_cast<int>(distances_.size())) return inf();
        if (point.x < 0 || point.x >= static_cast<int>(distances_[point.y].size())) return inf();
        return distances_[point.y][point.x];
    }

    void set(Point point, int value) { distances_[point.y][point.x] = value; }

    const std::vector<std::vector<int>>& values() const { return distances_; }

    static int inf() { return 1'000'000; }

private:
    std::vector<std::vector<int>> distances_;
};

template <class Passable>
DistanceMap bfs_distances(int height, int width, Point start, Passable passable) {
    DistanceMap distances(height, width, DistanceMap::inf());
    if (start.x < 0 || start.x >= width || start.y < 0 || start.y >= height || !passable(start)) return distances;

    std::queue<Point> queue;
    distances.set(start, 0);
    queue.push(start);

    while (!queue.empty()) {
        const auto current = queue.front();
        queue.pop();
        const int next_distance = distances.get(current) + 1;

        for (const auto direction : move_directions()) {
            const auto next = moved(current, direction);
            if (next.x < 0 || next.x >= width || next.y < 0 || next.y >= height) continue;
            if (!passable(next) || distances.get(next) <= next_distance) continue;
            distances.set(next, next_distance);
            queue.push(next);
        }
    }

    return distances;
}

template <class Passable>
std::optional<Direction> first_step_toward(int height, int width, Point start, Point target, Passable passable) {
    if (start == target) return Direction::Stay;
    const auto distances = bfs_distances(height, width, target, passable);
    int best_distance = DistanceMap::inf();
    std::optional<Direction> best;

    for (const auto direction : move_directions()) {
        const auto next = moved(start, direction);
        if (next.x < 0 || next.x >= width || next.y < 0 || next.y >= height) continue;
        if (!passable(next)) continue;
        const int distance = distances.get(next);
        if (distance < best_distance) {
            best_distance = distance;
            best = direction;
        }
    }

    return best;
}

// Propagates a probability distribution over the grid one step forward under an
// arbitrary per-cell transition model. `transition` maps a source cell to the
// distribution of intended moves leaving it; mass that would land on an
// impassable cell stays in place. Shared by both agents (each supplies its own
// opponent motion model).
template <class Transition, class Passable>
std::vector<std::vector<double>> propagate_belief(
    int height,
    int width,
    const std::vector<std::vector<double>>& belief,
    Transition transition,
    Passable passable
) {
    std::vector<std::vector<double>> next(height, std::vector<double>(width, 0.0));
    for (const auto [y, x] : std::views::cartesian_product(std::views::iota(0, height), std::views::iota(0, width))) {
        const double mass = belief[y][x];
        if (mass <= 0.0) continue;
        const Point from{x, y};
        for (const auto& [direction, probability] : transition(from)) {
            if (probability <= 0.0) continue;
            Point to = moved(from, direction);
            if (!passable(to)) to = from;
            next[to.y][to.x] += mass * probability;
        }
    }
    return next;
}

class RandomSource {
public:
    RandomSource() : engine_(std::random_device{}()) {}

    int integer(int low, int high) {
        std::uniform_int_distribution<int> dist(low, high);
        return dist(engine_);
    }

    double real(double low = 0.0, double high = 1.0) {
        std::uniform_real_distribution<double> dist(low, high);
        return dist(engine_);
    }

    template <class T>
    T choice(const std::vector<T>& values) {
        return values[integer(0, static_cast<int>(values.size()) - 1)];
    }

private:
    std::mt19937 engine_;
};

}  // namespace agent

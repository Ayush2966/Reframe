.PHONY: setup dev run build test phone

# First-time setup: tools, AI upscaler, tracking models, npm packages.
setup:
	./scripts/setup.sh

# Backend on :8787 and Vite on :5173 with hot reload. Open http://localhost:5173
dev:
	@trap 'kill 0' INT TERM EXIT; \
	(cd backend && go run . -root ..) & \
	(cd frontend && npm run dev) & \
	wait

build:
	cd frontend && npm run build
	cd backend && go build -o ../bin/reframe .

# Single process serving the built app. Open http://localhost:8787
run: build
	./bin/reframe -root .

test:
	cd backend && go test ./...
	cd frontend && npx vitest run

# Open Reframe on your phones: private HTTPS address via Tailscale.
phone:
	./scripts/phone.sh

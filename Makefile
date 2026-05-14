NAME=tornado
VERSION=$(shell cat package.json | grep version | head -1 | sed 's/.*: "\([^"]*\)".*/\1/')
REGISTRY_PREFIX=172.24.173.77:30500/

build:
	docker build -t ${NAME}:${VERSION} .

publish:
	docker tag ${NAME}:${VERSION} ${REGISTRY_PREFIX}${NAME}:${VERSION}
	docker push ${REGISTRY_PREFIX}${NAME}:${VERSION}

version:
	@echo ${VERSION}

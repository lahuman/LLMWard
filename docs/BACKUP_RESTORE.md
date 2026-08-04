# Backup and restore

`npm run backup` 또는 `POST /admin/backup`은 better-sqlite3 온라인 백업 API를 사용합니다. 파일은 `data/backups`에 생성되고 생성 UTC 시각, 스키마 버전, integrity 상태가 백업 DB와 운영 DB의 `backup_history`에 기록됩니다. WAL/SHM 파일을 직접 복사하지 마십시오.

복구 절차:

1. Gateway를 중지합니다.
2. 현재 DB 파일과 WAL/SHM 파일을 별도 격리 위치로 이동합니다.
3. 백업 파일에 `PRAGMA integrity_check`를 실행해 `ok`를 확인합니다.
4. 백업을 설정된 `DATABASE_PATH`로 복사합니다.
5. Gateway를 시작하고 `npm run doctor`를 실행합니다.

복구는 의도적으로 자동 API로 제공하지 않습니다. 실행 중 DB를 덮어써 데이터 손실을 일으키는 경로를 만들지 않기 위해서입니다.

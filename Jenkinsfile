pipeline {
    agent any

    environment {
        DEPLOY_DIR = '/home/ubuntu/company-os-frontend'
        HOST       = 'ubuntu@172.17.0.1'
    }

    triggers {
        pollSCM('H/2 * * * *')
    }

    options {
        timeout(time: 20, unit: 'MINUTES')
        timestamps()
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '10'))
    }

    stages {

        stage('Checkout') {
            steps {
                checkout scm
                sh 'echo "Checked out: $(git log --oneline -1)"'
            }
        }

        stage('Build & Deploy') {
            when { branch 'main' }
            steps {
                sh """
                    ssh -o StrictHostKeyChecking=no ${HOST} '
                        set -e
                        cd ${DEPLOY_DIR}
                        git pull origin main
                        npm install --prefer-offline || npm install
                        npm run build
                        sudo systemctl restart company-os.service
                        sleep 3
                        sudo systemctl is-active company-os.service
                    '
                """
            }
        }

        stage('Verify') {
            when { branch 'main' }
            steps {
                sh """
                    sleep 3
                    ssh -o StrictHostKeyChecking=no ${HOST} \
                        'curl -sf http://localhost:3001/ | head -c 50 && echo " — OK"'
                """
            }
        }
    }

    post {
        always { cleanWs() }
        success { echo "qucogroup.com deployed — Build #${BUILD_NUMBER}" }
        failure { echo "qucogroup.com deploy FAILED — Build #${BUILD_NUMBER}" }
    }
}
